'use client';
export const dynamic = 'force-dynamic';
// Intended path: src/app/page.js
//
// Calls the routes built in earlier steps:
//   POST /api/create-shift  -> creates the SideShift shift + locks in the prompt
//   POST /api/execute-prompt -> polls settlement, unlocks the Claude response
//
// Requires (already needed by those routes too):
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
//
// No QR library dependency: deposit addresses are meant to be shared, so
// this renders the QR via api.qrserver.com. Swap in `qrcode.react` if you'd
// rather generate it client-side and make zero external calls.


import { useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
const supabase = createBrowserClient(
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';
const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);


const COIN_OPTIONS = [
  { label: 'Bitcoin (BTC)', coin: 'btc', network: 'bitcoin' },
  { label: 'Ethereum (ETH)', coin: 'eth', network: 'ethereum' },
  { label: 'USDC (Polygon)', coin: 'usdc', network: 'polygon' },
  { label: 'Litecoin (LTC)', coin: 'ltc', network: 'litecoin' },
  { label: 'Solana (SOL)', coin: 'sol', network: 'solana' },
];

const STATUS_TEXT = {
  waiting: 'Waiting for your deposit',
  pending: 'Deposit detected — confirming on-chain',
  processing: 'Converting your payment',
  review: 'Under manual review by SideShift — this can take a while',
  settled: 'Paid',
  refunded: "Refunded — the swap couldn't complete",
  expired: 'This deposit address expired',
};

const IN_FLIGHT_STATUSES = ['pending', 'processing', 'review'];
const TERMINAL_STATUSES = ['settled', 'refunded', 'expired'];
const POLL_INTERVAL_MS = 4000;

function truncateMiddle(str, head = 8, tail = 6) {
  if (!str || str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function ensureAnonymousSession() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) return user;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error('Could not start a session: ' + error.message);
  return data.user;
}

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [selectedCoin, setSelectedCoin] = useState(COIN_OPTIONS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const [shift, setShift] = useState(null); // { paymentId, orderId, depositAddress, depositCoin, depositNetwork, depositAmount, expiresAt }
  const [status, setStatus] = useState(null);
  const [response, setResponse] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState(null);
  const [now, setNow] = useState(Date.now());

  const pollingActive = shift && !TERMINAL_STATUSES.includes(status);
  const isWaitingForDeposit = pollingActive && (status === 'waiting' || !status);
  const isInFlight = pollingActive && IN_FLIGHT_STATUSES.includes(status);

  const remaining = useMemo(() => {
    if (!shift?.expiresAt) return 0;
    return new Date(shift.expiresAt).getTime() - now;
  }, [shift, now]);

  // --- Poll /api/paywall/check-status while a payment is outstanding ---
  useEffect(() => {
    if (!pollingActive) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/execute-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId: shift.paymentId }),
        });
        const data = await res.json();
        if (!res.ok) return; // transient error — next tick retries
        setStatus(data.status);
        if (data.unlocked) setResponse(data.response);
      } catch {
        // network hiccup — next tick retries
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [pollingActive, shift?.paymentId]);

  // --- Tick the countdown once a second while waiting for a deposit ---
  useEffect(() => {
    if (!isWaitingForDeposit) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isWaitingForDeposit]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!prompt.trim()) {
      setError('Type a prompt first.');
      return;
    }

    setIsSubmitting(true);
    try {
      await ensureAnonymousSession();

      const res = await fetch('/api/create-shift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          depositCoin: selectedCoin.coin,
          depositNetwork: selectedCoin.network,
          prompt: prompt.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the payment.');

      setShift(data);
      setStatus(data.status || 'waiting');
      setResponse(null);
      setModalOpen(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function resetAll() {
    setShift(null);
    setStatus(null);
    setResponse(null);
    setModalOpen(false);
    setPrompt('');
    setError(null);
  }

  async function copyToClipboard(text, field) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // clipboard permission denied — silently ignore
    }
  }

  return (
    <div className="min-h-screen bg-[#F0EEE6] text-[#14151A] flex items-center justify-center px-4 py-12 font-sans">
      <style>{`
        @keyframes stamp-in {
          0% { opacity: 0; transform: scale(2.2) rotate(-18deg); }
          60% { opacity: 1; transform: scale(0.9) rotate(-8deg); }
          100% { opacity: 1; transform: scale(1) rotate(-8deg); }
        }
        .stamp-anim { animation: stamp-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        @keyframes dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
        .dot { animation: dot-bounce 1.1s ease-in-out infinite; }
      `}</style>

      <main className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#6B6A63]">
            Coin-op AI · No account
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Ask anything. $0.25 in crypto.</h1>
          <p className="mt-1 text-sm text-[#6B6A63]">
            Type a question, pay from any wallet, get your answer.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white border-2 border-[#14151A] rounded-lg p-5 shadow-[4px_4px_0_0_#14151A]"
        >
          <label className="block font-mono text-xs uppercase tracking-wide text-[#6B6A63] mb-1">
            Your prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="What do you want to know?"
            className="w-full resize-none border-2 border-[#14151A] rounded-md p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#0F7A54]"
          />

          <label className="block font-mono text-xs uppercase tracking-wide text-[#6B6A63] mt-4 mb-1">
            Pay with
          </label>
          <div className="relative">
            <select
              value={selectedCoin.label}
              onChange={(e) => {
                const next = COIN_OPTIONS.find((c) => c.label === e.target.value);
                if (next) setSelectedCoin(next);
              }}
              className="w-full appearance-none border-2 border-[#14151A] rounded-md px-3 py-2 pr-8 text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-[#0F7A54]"
            >
              {COIN_OPTIONS.map((c) => (
                <option key={c.label} value={c.label}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#6B6A63] font-mono text-xs">
              ▼
            </span>
          </div>

          {error && <p className="mt-3 text-sm font-mono text-[#B3261E]">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-5 w-full bg-[#14151A] text-[#F0EEE6] font-mono uppercase tracking-wide text-sm py-3 rounded-md shadow-[3px_3px_0_0_#0F7A54] transition hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none disabled:opacity-50 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-[3px_3px_0_0_#0F7A54] flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="h-3.5 w-3.5 rounded-full border-2 border-[#F0EEE6]/40 border-t-[#F0EEE6] animate-spin" />
                Starting…
              </>
            ) : (
              'Insert $0.25 →'
            )}
          </button>
        </form>

        {/* Reappears if the modal was dismissed while a payment is still outstanding */}
        {pollingActive && !modalOpen && (
          <button
            onClick={() => setModalOpen(true)}
            className="mt-4 w-full flex items-center justify-between border-2 border-dashed border-[#14151A]/40 rounded-md px-4 py-2 text-sm font-mono text-[#6B6A63] hover:border-[#14151A] transition"
          >
            <span>Payment pending — {STATUS_TEXT[status] || 'checking…'}</span>
            <span className="underline">View</span>
          </button>
        )}
      </main>

      {modalOpen && shift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#14151A]/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-sm bg-[#F7F6F1] border-2 border-[#14151A] rounded-xl p-5 shadow-[6px_6px_0_0_#14151A]">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#6B6A63]">
                  Ticket #{shift.orderId?.slice(0, 8).toUpperCase()}
                </p>
                <p className="font-mono text-sm font-semibold mt-0.5">
                  {STATUS_TEXT[status] || 'Checking…'}
                </p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="text-[#6B6A63] hover:text-[#14151A] font-mono text-sm"
                aria-label="Hide (your payment keeps being checked in the background)"
              >
                ✕
              </button>
            </div>

            {isWaitingForDeposit && (
              <>
                <div className="mt-4 flex justify-center">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
                      shift.depositAddress
                    )}`}
                    alt="Scan to send the deposit"
                    className="h-[180px] w-[180px] border-2 border-[#14151A] rounded-md bg-white p-2"
                  />
                </div>

                <p className="mt-4 text-center font-mono text-lg font-semibold tabular-nums">
                  {shift.depositAmount} {shift.depositCoin?.toUpperCase()}
                </p>

                <button
                  onClick={() => copyToClipboard(shift.depositAddress, 'address')}
                  className="mt-2 w-full flex items-center justify-between gap-2 border-2 border-[#14151A] rounded-md px-3 py-2 text-xs font-mono bg-white hover:bg-[#F0EEE6] transition"
                  title={shift.depositAddress}
                >
                  <span className="truncate">{truncateMiddle(shift.depositAddress)}</span>
                  <span className="shrink-0 text-[#0F7A54]">
                    {copiedField === 'address' ? 'Copied' : 'Copy'}
                  </span>
                </button>

                <div className="relative my-5 -mx-5">
                  <div className="border-t-2 border-dashed border-[#14151A]/30" />
                  <span className="absolute -left-[10px] -top-[10px] h-5 w-5 rounded-full bg-[#14151A]/70" />
                  <span className="absolute -right-[10px] -top-[10px] h-5 w-5 rounded-full bg-[#14151A]/70" />
                </div>

                <div className="flex items-center justify-between font-mono text-xs text-[#6B6A63]">
                  <span className="flex items-center gap-1.5">
                    <span className="dot h-1.5 w-1.5 rounded-full bg-[#0F7A54]" style={{ animationDelay: '0ms' }} />
                    <span className="dot h-1.5 w-1.5 rounded-full bg-[#0F7A54]" style={{ animationDelay: '150ms' }} />
                    <span className="dot h-1.5 w-1.5 rounded-full bg-[#0F7A54]" style={{ animationDelay: '300ms' }} />
                    <span className="ml-1">Checking every few seconds</span>
                  </span>
                  <span className={remaining < 60000 ? 'text-[#B3261E]' : ''}>
                    Expires {formatTimeRemaining(remaining)}
                  </span>
                </div>
              </>
            )}

            {isInFlight && (
              <div className="mt-6 flex flex-col items-center gap-3 py-4">
                <span className="flex items-center gap-1.5">
                  <span className="dot h-2 w-2 rounded-full bg-[#0F7A54]" style={{ animationDelay: '0ms' }} />
                  <span className="dot h-2 w-2 rounded-full bg-[#0F7A54]" style={{ animationDelay: '150ms' }} />
                  <span className="dot h-2 w-2 rounded-full bg-[#0F7A54]" style={{ animationDelay: '300ms' }} />
                </span>
                <p className="text-sm text-[#6B6A63] text-center">{STATUS_TEXT[status]}</p>
              </div>
            )}

            {status === 'settled' && (
              <div className="mt-4">
                <div className="flex justify-center">
                  <span className="stamp-anim inline-block border-4 border-double border-[#0F7A54] text-[#0F7A54] font-mono uppercase tracking-[0.3em] text-sm px-4 py-1.5 rounded -rotate-6">
                    Paid
                  </span>
                </div>

                <div className="mt-4 border-2 border-[#14151A] rounded-md bg-white p-3">
                  <p className="font-mono text-[10px] uppercase tracking-wide text-[#6B6A63] mb-2">
                    Your answer
                  </p>
                  <p className="text-sm whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
                    {response}
                  </p>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => copyToClipboard(response || '', 'response')}
                    className="flex-1 border-2 border-[#14151A] rounded-md py-2 text-xs font-mono hover:bg-[#F0EEE6] transition"
                  >
                    {copiedField === 'response' ? 'Copied' : 'Copy answer'}
                  </button>
                  <button
                    onClick={resetAll}
                    className="flex-1 bg-[#14151A] text-[#F0EEE6] rounded-md py-2 text-xs font-mono hover:opacity-90 transition"
                  >
                    Ask another
                  </button>
                </div>
              </div>
            )}

            {status === 'expired' && (
              <div className="mt-4 text-center">
                <span className="inline-block border-4 border-double border-[#B3261E] text-[#B3261E] font-mono uppercase tracking-[0.3em] text-sm px-4 py-1.5 rounded rotate-3">
                  Expired
                </span>
                <p className="mt-3 text-sm text-[#6B6A63]">
                  This deposit address timed out before funds arrived.
                </p>
                <button
                  onClick={resetAll}
                  className="mt-4 w-full bg-[#14151A] text-[#F0EEE6] rounded-md py-2 text-xs font-mono hover:opacity-90 transition"
                >
                  Try again
                </button>
              </div>
            )}

            {status === 'refunded' && (
              <div className="mt-4 text-center">
                <p className="text-sm text-[#6B6A63]">{STATUS_TEXT.refunded}.</p>
                <button
                  onClick={resetAll}
                  className="mt-4 w-full bg-[#14151A] text-[#F0EEE6] rounded-md py-2 text-xs font-mono hover:opacity-90 transition"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
