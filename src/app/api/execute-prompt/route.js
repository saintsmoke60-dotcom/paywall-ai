// Path: src/app/api/execute-prompt/route.js
//
// POST body: { paymentId: "<uuid returned by /api/create-shift>" }
//
// What this does, in order:
//   1. Uses the caller's own Supabase session (anon key + cookie) to load
//      the payment. RLS's "select_own_payments" policy means this simply
//      returns nothing if the payment belongs to someone else.
//   2. Asks SideShift for the shift's live status via GET /shifts/{id}.
//      SideShift's own value for "funds arrived in our wallet" is
//      'settled' — not 'COMPLETED'. That's the value actually checked here;
//      matching against a status the API never sends would leave every
//      payment stuck at "checking" forever.
//   3. Any status write goes through the SERVICE ROLE client, because RLS
//      grants no update policy to anon/authenticated roles — that's the
//      real security boundary, not this route's own logic.
//   4. The first time a payment is seen as settled, it pulls the prompt
//      that was locked in back at create-shift time, runs it through
//      Claude exactly once, and stores + returns the result. Later polls
//      of an already-settled payment return the cached response instead of
//      calling Claude (or SideShift) again.
//
// Required env vars (beyond what create-shift already uses):
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//   ANTHROPIC_MODEL   (optional — see docs.claude.com for current model IDs)

import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const SIDESHIFT_BASE = 'https://sideshift.ai/api/v2';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function mapSideshiftStatus(shiftStatus) {
  const map = {
    waiting: 'waiting',
    pending: 'pending',
    processing: 'processing',
    review: 'review',
    settled: 'settled',
    refund: 'refunded',
    refunding: 'refunded',
    expired: 'expired',
  };
  return map[shiftStatus] || 'pending';
}

export async function POST(request) {
  try {
    const { paymentId } = await request.json();
    if (!paymentId) {
      return NextResponse.json({ error: 'paymentId is required' }, { status: 400 });
    }

    // --- 1. Authenticate the caller and load the payment through RLS ---
    const cookieStore = cookies();
    const authedClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { cookies: { get: (name) => cookieStore.get(name)?.value } }
    );

    const {
      data: { user },
      error: authError,
    } = await authedClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'No active session' }, { status: 401 });
    }

    const { data: payment, error: paymentError } = await authedClient
      .from('payments')
      .select('*')
      .eq('id', paymentId)
      .single();

    if (paymentError || !payment) {
      // Doesn't exist, or belongs to someone else — RLS makes these look
      // identical from here, which is the point.
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    // Already settled from a previous call — return the cached result.
    if (payment.status === 'settled') {
      const { data: existing } = await authedClient
        .from('prompt_responses')
        .select('response')
        .eq('payment_id', paymentId)
        .single();

      return NextResponse.json({
        status: 'settled',
        unlocked: true,
        response: existing?.response ?? null,
      });
    }

    // --- 2. Ask SideShift for the live status of this shift ---
    const shiftRes = await fetch(`${SIDESHIFT_BASE}/shifts/${payment.sideshift_order_id}`);
    const shift = await shiftRes.json();

    if (!shiftRes.ok) {
      return NextResponse.json(
        { error: shift?.error?.message || 'Failed to check SideShift status' },
        { status: 502 }
      );
    }

    const mappedStatus = mapSideshiftStatus(shift.status);

    // Everything from here writes through the service-role client, since
    // RLS gives no update grant to anon/authenticated — this is the actual
    // gate, not a check we're trusting the client to respect.
    const serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (mappedStatus !== 'settled') {
      if (mappedStatus !== payment.status) {
        await serviceClient.from('payments').update({ status: mappedStatus }).eq('id', paymentId);
      }
      return NextResponse.json({ status: mappedStatus, unlocked: false });
    }

    // --- 3. First time settling: mark it, then unlock the Claude result ---
    await serviceClient.from('payments').update({ status: 'settled' }).eq('id', paymentId);

    const { data: pending, error: pendingError } = await serviceClient
      .from('prompt_responses')
      .select('prompt')
      .eq('payment_id', paymentId)
      .single();

    if (pendingError || !pending) {
      return NextResponse.json(
        { error: 'Payment settled, but no prompt was locked in for it.' },
        { status: 500 }
      );
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: pending.prompt }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      // Payment stays 'settled' — the user paid — this just means the
      // Claude call itself needs a retry, which you can safely re-run
      // (response is still null) without asking them to pay again.
      console.error('Claude API error after settlement:', claudeData);
      return NextResponse.json(
        {
          status: 'settled',
          unlocked: false,
          error: 'Payment confirmed, but generating the response failed. Try again shortly.',
        },
        { status: 502 }
      );
    }

    const responseText = (claudeData.content || []).map((block) => block.text || '').join('\n');

    await serviceClient.from('prompt_responses').update({ response: responseText }).eq('payment_id', paymentId);

    return NextResponse.json({ status: 'settled', unlocked: true, response: responseText });
  } catch (err) {
    console.error('execute-prompt route error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
