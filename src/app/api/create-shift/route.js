// Path: src/app/api/create-shift/route.js
//
// POST body: { depositCoin: "btc", depositNetwork: "bitcoin", prompt: "..." }
// (depositCoin/depositNetwork = the crypto/network the END USER pays with —
// typically chosen from SideShift's GET /coins list in your UI)
//
// What this does:
//   1. Confirms the caller has a Supabase session (anonymous auth is fine).
//   2. Gets a fixed-rate SideShift quote for exactly $0.25 in USDC settling
//      to your wallet, then turns it into a shift (which generates the
//      deposit address).
//   3. Logs the payment row with status 'waiting' — SideShift's own initial
//      state for "address generated, no funds seen yet." (Not 'PENDING':
//      that value is reserved in this schema for "funds detected, awaiting
//      confirmations," which is a real, later, distinct state — collapsing
//      the two would make status changes unreadable once you're debugging
//      a stuck payment.)
//   4. Locks the prompt to that payment in the same request, before any
//      funds move, so it can't be swapped out after payment at unlock time.
//
// Required env vars:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY   (NOT the service role key — see note below)
//   SIDESHIFT_AFFILIATE_ID
//   SIDESHIFT_SECRET                (optional — gets you private/better rates)
//   SETTLE_WALLET_ADDRESS           (your self-custody wallet, receives USDC on Polygon)

import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const SIDESHIFT_BASE = 'https://sideshift.ai/api/v2';
const SETTLE_COIN = 'usdc';
const SETTLE_NETWORK = 'polygon';
const PRICE_USD = 0.25;

function getUserIp(request) {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? '127.0.0.1';
}

function sideshiftHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SIDESHIFT_SECRET) {
    headers['x-sideshift-secret'] = process.env.SIDESHIFT_SECRET;
  }
  return headers;
}

export async function POST(request) {
  try {
    const { depositCoin, depositNetwork, prompt } = await request.json();

    if (!depositCoin || !depositNetwork) {
      return NextResponse.json(
        { error: 'depositCoin and depositNetwork are required' },
        { status: 400 }
      );
    }

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // --- 1. Identify the caller via their Supabase session cookie ---
    // The ANON key is used here (not service role) so this insert is
    // constrained by the "insert_own_payment" RLS policy: the row can only
    // be created with user_id = auth.uid(). The client must have already
    // called supabase.auth.signInAnonymously() so a session cookie exists.
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookies: {
          get: (name) => cookieStore.get(name)?.value,
        },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'No active session. Call supabase.auth.signInAnonymously() on the client first.' },
        { status: 401 }
      );
    }

    const userIp = getUserIp(request);

    // --- 2. Get a fixed-rate quote: user deposits `depositCoin`, we want ---
    //         to *settle* exactly $0.25 worth of USDC into our wallet.
    const quoteRes = await fetch(`${SIDESHIFT_BASE}/quotes`, {
      method: 'POST',
      headers: { ...sideshiftHeaders(), 'x-user-ip': userIp },
      body: JSON.stringify({
        depositCoin,
        depositNetwork,
        settleCoin: SETTLE_COIN,
        settleNetwork: SETTLE_NETWORK,
        settleAmount: String(PRICE_USD),
        affiliateId: process.env.SIDESHIFT_AFFILIATE_ID,
      }),
    });

    const quote = await quoteRes.json();

    if (!quoteRes.ok) {
      return NextResponse.json(
        { error: quote?.error?.message || 'Failed to get SideShift quote' },
        { status: 502 }
      );
    }

    // --- 3. Turn the quote into a fixed shift — this generates the ---
    //         actual deposit address the user sends funds to.
    const shiftRes = await fetch(`${SIDESHIFT_BASE}/shifts/fixed`, {
      method: 'POST',
      headers: { ...sideshiftHeaders(), 'x-user-ip': userIp },
      body: JSON.stringify({
        quoteId: quote.id,
        settleAddress: process.env.SETTLE_WALLET_ADDRESS,
        affiliateId: process.env.SIDESHIFT_AFFILIATE_ID,
      }),
    });

    const shift = await shiftRes.json();

    if (!shiftRes.ok) {
      return NextResponse.json(
        { error: shift?.error?.message || 'Failed to create SideShift shift' },
        { status: 502 }
      );
    }

    // --- 4. Log the payment row (RLS-scoped to this user) as 'waiting' ---
    const { data: payment, error: dbError } = await supabase
      .from('payments')
      .insert({
        user_id: user.id,
        sideshift_order_id: shift.id,
        sideshift_quote_id: quote.id,
        deposit_coin: shift.depositCoin,
        deposit_network: shift.depositNetwork,
        deposit_address: shift.depositAddress,
        deposit_amount: shift.depositAmount,
        settle_coin: SETTLE_COIN,
        settle_network: SETTLE_NETWORK,
        settle_amount: PRICE_USD,
        status: 'waiting',
        expires_at: shift.expiresAt,
      })
      .select()
      .single();

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    // Lock the prompt to this payment now, before the user has sent any
    // funds. execute-prompt will only ever run *this* stored prompt through
    // Claude — a user can't swap in a different prompt after paying.
    const { error: promptError } = await supabase.from('prompt_responses').insert({
      payment_id: payment.id,
      user_id: user.id,
      prompt: prompt.trim(),
      response: null,
    });

    if (promptError) {
      return NextResponse.json({ error: promptError.message }, { status: 500 });
    }

    return NextResponse.json({
      paymentId: payment.id,
      orderId: shift.id,
      depositAddress: shift.depositAddress,
      depositCoin: shift.depositCoin,
      depositNetwork: shift.depositNetwork,
      depositAmount: shift.depositAmount, // amount of depositCoin the user must send
      expiresAt: shift.expiresAt,
      status: shift.status,
    });
  } catch (err) {
    console.error('create-shift route error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
