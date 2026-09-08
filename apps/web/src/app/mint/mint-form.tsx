"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { requiresTaproot, xOnly } from "@/lib/wallet/adapter";
import { guessContentType, classifyMimeType } from "@/lib/inscribe/content";
import {
  NonStandardRevealError,
  RevealPendingError,
  finishReveal,
  mintCounter,
  type EnvelopeStyle,
  type MintPlan,
  type MintResult,
  type MintStage,
} from "@/lib/inscribe/mint";
import { ConnectInline } from "@/components/connect-inline";
import { copy } from "@content/copy";
import { fill } from "@content/fill";
import { fetchHalfHourFeeRate } from "@/lib/esplora";
import { fmtSize } from "@/lib/format";
import { NAMED_ASSET_XCP_BURN, STANDARD_WITNESS_LIMIT_WU, mempoolTxUrl } from "@/lib/constants";

/**
 * Mint a counter.
 *
 * Freeform: the file, the name, the supply and the fee rate are all the
 * minter's to choose. The site imposes exactly one thing, and it is the same
 * thing it imposes everywhere — the description must be the file itself, not a
 * link to one. That is not a policy bolted on here; it is what makes the
 * result a counter rather than a token with a picture somewhere.
 */

const STAGE_COPY: Record<MintStage, string> = copy.mint.stages;

/** Counterparty's rule: 4–12 letters, first not A (that prefix is numeric). */
const NAMED_ASSET = /^[B-Z][A-Z]{3,11}$/;

export function MintForm() {
  const wallet = useWallet();

  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [mimeType, setMimeType] = useState("");
  const [asset, setAsset] = useState("");
  const [supply, setSupply] = useState("1");
  const [divisible, setDivisible] = useState(false);
  const [lockQuantity, setLockQuantity] = useState(true);
  const [envelope, setEnvelope] = useState<EnvelopeStyle>("counterparty");
  const [satPerVbyte, setSatPerVbyte] = useState("2");
  const [suggestedRate, setSuggestedRate] = useState<number | null>(null);

  // A live estimate, but only as a suggestion. The mint's cost scales with the
  // file, so a fee rate picked for a 300-byte send is the wrong default for a
  // 200 KB inscription — the number stays the minter's to choose, and the
  // estimate sits beside it rather than overwriting it.
  useEffect(() => {
    let cancelled = false;
    fetchHalfHourFeeRate()
      .then((rate) => {
        if (!cancelled && rate) setSuggestedRate(rate);
      })
      .catch(() => {
        // No estimate is a fine outcome; the field already has a value.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [stage, setStage] = useState<MintStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MintResult | null>(null);
  const [pending, setPending] = useState<{ psbt: string; plan: MintPlan } | null>(null);

  // The signed reveal PSBT, held for the whole session. If the reveal signature
  // fails after the commit is on chain, this is the entire recovery path.
  const stashedReveal = useRef<string | null>(null);

  const onFile = useCallback(async (picked: File) => {
    setFile(picked);
    setMimeType(guessContentType(picked));
    setBytes(new Uint8Array(await picked.arrayBuffer()));
    setError(null);
  }, []);

  const estimate = useMemo(() => {
    if (!bytes) return null;
    // The envelope adds a fixed frame around the body; the body dominates.
    // Witness bytes are discounted 4:1, which is the whole reason counters live
    // in witness data rather than in outputs.
    const witnessBytes = bytes.length + 200;
    const revealWeight = witnessBytes + 700;
    const revealVbytes = Math.ceil(revealWeight / 4);
    const rate = Number(satPerVbyte) || 1;
    return {
      bytes: bytes.length,
      revealWeight,
      revealVbytes,
      revealFee: Math.ceil(revealVbytes * rate),
      nonStandard: revealWeight > STANDARD_WITNESS_LIMIT_WU,
    };
  }, [bytes, satPerVbyte]);

  const assetError = useMemo(() => {
    if (!asset) return null; // empty means a free numeric asset
    if (asset.includes(".")) return null; // subasset — Core validates the parent
    if (!NAMED_ASSET.test(asset)) {
      return copy.mint.asset.invalid;
    }
    return null;
  }, [asset]);

  // A commit pays a taproot script whose leaf names the signer's own key, so
  // only a p2tr account can mint. Surfaced before composing rather than as a
  // wallet rejection after the user has approved a payment.
  const walletError = requiresTaproot(wallet.account);
  const ready =
    wallet.address !== null &&
    walletError === null &&
    bytes !== null &&
    !assetError &&
    stage === null &&
    !result;

  const run = useCallback(async () => {
    if (!bytes || !wallet.adapter || !wallet.address || !wallet.publicKey) return;
    setError(null);
    setResult(null);

    try {
      const mint = await mintCounter(
        wallet.adapter,
        {
          source: wallet.address,
          // The leaf is re-keyed to the signer's own taproot output key.
          sourceXOnly: xOnly(wallet.publicKey),
          asset,
          body: bytes,
          mimeType,
          quantity: BigInt(supply || "0") * (divisible ? 100_000_000n : 1n),
          divisible,
          lockQuantity,
          satPerVbyte: Number(satPerVbyte) || 1,
          envelope,
        },
        setStage,
        (psbt, plan) => {
          // Stashed BEFORE the commit is broadcast. A mint that fails after
          // this point is recoverable; one that fails before it has cost
          // nothing.
          stashedReveal.current = psbt;
          setPending({ psbt, plan });
        },
      );
      setResult(mint);
      setPending(null);
    } catch (err) {
      if (err instanceof RevealPendingError) {
        setError(err.message);
        stashedReveal.current = err.revealPsbt;
      } else if (err instanceof NonStandardRevealError) {
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setStage(null);
    }
  }, [
    asset,
    bytes,
    divisible,
    envelope,
    lockQuantity,
    mimeType,
    satPerVbyte,
    supply,
    wallet.adapter,
    wallet.address,
    wallet.publicKey,
  ]);

  const retryReveal = useCallback(async () => {
    const psbt = stashedReveal.current;
    if (!psbt || !wallet.adapter || !wallet.address) return;

    setError(null);
    try {
      const reveal = await finishReveal(wallet.adapter, wallet.address, psbt, setStage);
      setResult({ ...(pending!.plan as MintResult), revealBroadcast: reveal.txid, revealTxid: reveal.txid });
      setPending(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStage(null);
    }
  }, [pending, wallet.adapter, wallet.address]);

  if (result) return <Receipt result={result} asset={asset} />;

  return (
    <div className="flex flex-col gap-5">
      <Well label={copy.mint.file.label}>
        <FileDrop file={file} bytes={bytes} onFile={onFile} />
        {file && (
          <div className="mt-3 flex flex-col gap-2">
            <Row label="mime type">
              <input
                value={mimeType}
                onChange={(e) => setMimeType(e.target.value)}
                className="w-48 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper"
              />
            </Row>
            <p className="text-[11px] leading-relaxed text-faint">
              {/* The MIME is committed to by the envelope and is permanent. It
                  also decides how the bytes are encoded: textual types go
                  across as UTF-8, binary as hex. */}
              {copy.mint.file.mimeNote}{" "}
              {classifyMimeType(mimeType) === "text"
                ? copy.mint.file.mimeText
                : copy.mint.file.mimeBinary}
            </p>
          </div>
        )}
      </Well>

      <Well label={copy.mint.asset.label}>
        <Row label="name">
          <input
            value={asset}
            onChange={(e) => setAsset(e.target.value.toUpperCase())}
            placeholder={copy.mint.asset.namePlaceholder}
            className="w-72 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-copper"
          />
        </Row>
        <p className="mt-1.5 text-[11px] text-faint">
          {asset ? copy.mint.asset.named(NAMED_ASSET_XCP_BURN) : copy.mint.asset.numeric}
        </p>
        {assetError && <p className="mt-1.5 text-[11px] text-bad">{assetError}</p>}

        <div className="mt-4 flex flex-col gap-2 border-t border-line2 pt-3">
          <Row label="supply">
            <input
              value={supply}
              onChange={(e) => setSupply(e.target.value.replace(/[^\d]/g, ""))}
              className="w-32 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper"
            />
          </Row>
          <Toggle label="divisible" value={divisible} onChange={setDivisible} />
          <Toggle label="lock supply" value={lockQuantity} onChange={setLockQuantity} />
        </div>
      </Well>

      <Well label={copy.mint.envelope.label}>
        <div className="flex flex-col gap-2">
          <Choice
            label={copy.mint.envelope.native}
            hint={copy.mint.envelope.nativeHint}
            active={envelope === "counterparty"}
            onClick={() => setEnvelope("counterparty")}
          />
          <Choice
            label={copy.mint.envelope.ord}
            hint={copy.mint.envelope.ordHint}
            active={envelope === "counterparty/ord"}
            onClick={() => setEnvelope("counterparty/ord")}
          />
        </div>

        <div className="mt-4 border-t border-line2 pt-3">
          <Row label="fee rate">
            <span className="flex items-center gap-1.5">
              <input
                value={satPerVbyte}
                onChange={(e) => setSatPerVbyte(e.target.value.replace(/[^\d.]/g, ""))}
                className="w-20 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper"
              />
              <span className="font-mono text-[11px] text-faint">sat/vB</span>
            </span>
          </Row>
          {suggestedRate !== null && (
            <button
              onClick={() => setSatPerVbyte(String(suggestedRate))}
              className="mt-1 font-mono text-[10px] text-faint hover:text-copper2"
            >
              mempool is at ~{suggestedRate} sat/vB — use it
            </button>
          )}
        </div>
      </Well>

      {estimate && (
        <div className="rounded-2xl border border-line bg-card p-5">
          <Row label="on chain">
            <span className="font-mono text-xs text-ink">{fmtSize(estimate.bytes)}</span>
          </Row>
          <Row label="reveal weight">
            <span className="font-mono text-xs text-ink">
              {estimate.revealWeight.toLocaleString("en-US")} WU
            </span>
          </Row>
          <Row label="reveal fee (est.)">
            <span className="font-mono text-xs text-ink">
              ~{estimate.revealFee.toLocaleString("en-US")} sat
            </span>
          </Row>
          {estimate.nonStandard && (
            <p className="mt-3 rounded-lg border border-gold/40 bg-gold/5 p-3 text-[11px] leading-relaxed text-gold">
              {/* This is a relay policy limit on witness weight, not a price.
                  Raising the fee rate does not help. */}
              {fill(copy.mint.nonStandard)}
            </p>
          )}
        </div>
      )}

      {walletError && wallet.address && (
        <div className="rounded-2xl border border-gold/40 bg-gold/5 p-4 text-sm text-gold">
          {walletError}
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-bad/40 bg-bad/5 p-4 text-sm text-bad">
          {error}
          {stashedReveal.current && pending && (
            <button
              onClick={retryReveal}
              className="mt-3 block rounded-xl border border-copper px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-copper2"
            >
              sign the reveal again
            </button>
          )}
        </div>
      )}

      {wallet.address ? (
        <button
          disabled={!ready}
          onClick={run}
          className="rounded-xl border border-copper bg-copper-ghost px-5 py-3 font-mono text-xs uppercase tracking-[0.12em] text-copper2 transition-colors enabled:hover:bg-copper enabled:hover:text-bg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
        >
          {stage ? STAGE_COPY[stage] : walletError ? copy.mint.ctaTaproot : copy.mint.cta}
        </button>
      ) : (
        <ConnectInline />
      )}

      <p className="text-[11px] leading-relaxed text-faint">{copy.mint.footnote}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- */

function Receipt({ result, asset }: { result: MintResult; asset: string }) {
  return (
    <div className="rounded-2xl border border-patina/40 bg-patina/5 p-6">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">{copy.mint.receipt.label}</p>
      <h2 className="mb-4 font-mono text-2xl text-ink">{asset || "your numeric asset"}</h2>
      <p className="mb-5 text-sm text-dim">{copy.mint.receipt.body}</p>
      <div className="flex flex-col gap-2">
        <Row label="commit">
          <a
            href={mempoolTxUrl(result.commitBroadcast)}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-xs text-copper2 underline-offset-2 hover:underline"
          >
            {result.commitBroadcast.slice(0, 16)}…
          </a>
        </Row>
        <Row label="reveal">
          <a
            href={mempoolTxUrl(result.revealBroadcast)}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-xs text-copper2 underline-offset-2 hover:underline"
          >
            {result.revealBroadcast.slice(0, 16)}…
          </a>
        </Row>
        <Row label="total fee">
          <span className="font-mono text-xs text-ink">
            {result.totalFee.toLocaleString("en-US")} sat
          </span>
        </Row>
      </div>
    </div>
  );
}

function FileDrop({
  file,
  bytes,
  onFile,
}: {
  file: File | null;
  bytes: Uint8Array | null;
  onFile: (f: File) => void;
}) {
  return (
    <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-bg2 p-8 text-center transition-colors hover:border-copper">
      <input
        type="file"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) onFile(picked);
        }}
      />
      {file && bytes ? (
        <>
          <span className="font-mono text-sm text-copper2">{file.name}</span>
          <span className="font-mono text-[11px] text-faint">{fmtSize(bytes.length)}</span>
        </>
      ) : (
        <>
          <span className="font-mono text-sm text-dim">{copy.mint.file.choose}</span>
          <span className="text-[11px] text-faint">{copy.mint.file.hint}</span>
        </>
      )}
    </label>
  );
}

function Well({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label}>
      <button
        onClick={() => onChange(!value)}
        className={`rounded-lg border px-3 py-1 font-mono text-[11px] transition-colors ${
          value ? "border-copper text-copper2" : "border-line text-faint"
        }`}
      >
        {value ? "yes" : "no"}
      </button>
    </Row>
  );
}

function Choice({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition-colors ${
        active ? "border-copper bg-copper-ghost" : "border-line hover:border-line2"
      }`}
    >
      <div className={`font-mono text-xs ${active ? "text-copper2" : "text-dim"}`}>{label}</div>
      <div className="mt-0.5 text-[11px] text-faint">{hint}</div>
    </button>
  );
}
