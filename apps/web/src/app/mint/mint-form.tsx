"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/wallet-context";
import { requiresTaproot, xOnly } from "@/lib/wallet/adapter";
import { guessContentType, classifyMimeType } from "@/lib/inscribe/content";
import {
  NonStandardRevealError,
  RevealPendingError,
  finishReveal,
  lockDescription,
  mintCounter,
  type EnvelopeStyle,
  type FairminterPreset,
  type MintMode,
  type MintPlan,
  type MintResult,
  type MintStage,
} from "@/lib/inscribe/mint";
import { ConnectInline } from "@/components/connect-inline";
import { FeeRateField, useFeeRate } from "@/components/fee-rate";
import { effectiveRate, estimateMint, formatFeeRate, vbytesOf } from "@counters/core/fees";
import { copy } from "@content/copy";
import { fill } from "@content/fill";
import { fmtQty, fmtSize } from "@/lib/format";
import { STANDARD_WITNESS_LIMIT_WU, mempoolTxUrl } from "@/lib/constants";
import { classifyAssetName, issuanceBurnXcp, randomNumericAsset } from "@counters/core/assetnames";
import { XCP69, XCP69_DEFAULT_START_LEAD, XCP69_MIN_START_LEAD, xcp69Params, xcp69Schedule } from "@counters/core/xcp69";
import { fairminterProblems, type FairminterParams } from "@counters/core/fairminter";
import { parseUnitsToRaw } from "@counters/core/numeric";
import { fetchAsset, fetchBalance, fetchBtcFunds, fetchTip, type AssetInfo, type BtcFunds } from "@/lib/cp";
import { describeError, isCancellation } from "@/lib/errors";
import { clearPendingMint, loadPendingMint, savePendingMint, type PendingMint } from "@/lib/pending-mint";

/**
 * Mint a counter — as a new asset, as a new file on an asset you own, or as
 * an XCP-69 launch.
 *
 * The site imposes exactly one thing, and it is the same thing it imposes
 * everywhere — the description must be the file itself, not a link to one.
 * That is not a policy bolted on here; it is what makes the result a counter
 * rather than a token with a picture somewhere.
 *
 * Everything that can be known before a signature is asked for is checked
 * before it: the name's shape and whether it exists, the XCP a named asset
 * burns, the BTC the two transactions need, and the reveal's exact weight.
 * The node's compose remains the authority; these are so the person hears
 * about a problem from a sentence rather than from a rejected transaction.
 */

const STAGE_COPY: Record<MintStage, string> = copy.mint.stages;
const XCP_RAW = 100_000_000n;

/** The custom sale's fields, in display units, starting from XCP-69's numbers. */
interface SaleFields {
  lotPrice: string;
  lotSize: string;
  hardCap: string;
  softCap: string;
  poolQuantity: string;
  maxMintPerAddress: string;
  maxMintPerTx: string;
  premint: string;
  commission: string;
  burnPayment: boolean;
  lockQuantity: boolean;
  lockDescription: boolean;
  divisible: boolean;
  window: string;
  endAfter: string;
}
const XCP69_FIELDS: SaleFields = {
  lotPrice: "0.01",
  lotSize: "1000",
  hardCap: "100000000",
  softCap: "69000000",
  poolQuantity: "31000000",
  maxMintPerAddress: "1000000",
  maxMintPerTx: "1000000",
  premint: "0",
  commission: "0",
  burnPayment: false,
  lockQuantity: true,
  lockDescription: true,
  divisible: true,
  window: String(XCP69.window_blocks),
  endAfter: "0",
};

/** Display units → raw. Tokens scale by divisibility; XCP always by 1e8. */
function saleParams(f: SaleFields, startBlock: number): FairminterParams {
  const tokens = (v: string) => parseUnitsToRaw(v || "0", f.divisible ? 8 : 0) ?? 0n;
  const window = Math.max(0, Number(f.window) || 0);
  const endAfter = Math.max(0, Number(f.endAfter) || 0);
  return {
    lotPrice: parseUnitsToRaw(f.lotPrice || "0", 8) ?? 0n,
    lotSize: tokens(f.lotSize),
    hardCap: tokens(f.hardCap),
    softCap: tokens(f.softCap),
    poolQuantity: tokens(f.poolQuantity),
    maxMintPerTx: tokens(f.maxMintPerTx),
    maxMintPerAddress: tokens(f.maxMintPerAddress),
    premintQuantity: tokens(f.premint),
    mintedAssetCommission: Math.max(0, Number(f.commission) || 0) / 100,
    burnPayment: f.burnPayment,
    lockQuantity: f.lockQuantity,
    lockDescription: f.lockDescription,
    divisible: f.divisible,
    startBlock,
    endBlock: endAfter > 0 ? startBlock + endAfter : 0,
    softCapDeadlineBlock: tokens(f.softCap) > 0n ? startBlock + window : 0,
  };
}

type AssetLookup = { state: "idle" } | { state: "checking" } | { state: "error" } | { state: "done"; info: AssetInfo | null };

export function MintForm() {
  const wallet = useWallet();

  const [mode, setMode] = useState<MintMode>("counter");
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [mimeType, setMimeType] = useState("");
  const [asset, setAsset] = useState("");
  const [supply, setSupply] = useState("1");
  const [divisible, setDivisible] = useState(false);
  const [lockQuantity, setLockQuantity] = useState(true);
  const [lockDesc, setLockDesc] = useState(false);
  const [envelope, setEnvelope] = useState<EnvelopeStyle>("counterparty");
  const fee = useFeeRate();
  const [preset, setPreset] = useState<FairminterPreset>("xcp69");
  const [sale, setSale] = useState<SaleFields>(XCP69_FIELDS);
  const [startLead, setStartLead] = useState(String(XCP69_DEFAULT_START_LEAD));
  const [tip, setTip] = useState<number | null>(null);
  const setSaleField = useCallback(<K extends keyof SaleFields>(key: K, value: SaleFields[K]) => setSale((f) => ({ ...f, [key]: value })), []);

  const [lookup, setLookup] = useState<AssetLookup>({ state: "idle" });
  const [xcpBalance, setXcpBalance] = useState<bigint | null | "error">(null);
  const [btc, setBtc] = useState<BtcFunds | null | "error">(null);

  const [stage, setStage] = useState<MintStage | null>(null);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [result, setResult] = useState<MintResult | null>(null);
  const [pending, setPending] = useState<PendingMint | null>(null);

  /* ---------------- lookups ---------------- */

  // The tip, for scheduling a launch. Refreshed every minute while on the page.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTip()
        .then((t) => {
          if (!cancelled) setTip(t);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Does the name exist? Debounced; the answer decides what the mode means.
  useEffect(() => {
    const name = asset.trim();
    if (!name || !classifyAssetName(name).ok) {
      setLookup({ state: "idle" });
      return;
    }
    let cancelled = false;
    setLookup({ state: "checking" });
    const timer = setTimeout(() => {
      fetchAsset(name)
        .then((info) => {
          if (!cancelled) setLookup({ state: "done", info });
        })
        .catch(() => {
          if (!cancelled) setLookup({ state: "error" });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [asset]);

  // Balances at the connected address, for the pre-flight card.
  useEffect(() => {
    if (!wallet.address) {
      setXcpBalance(null);
      setBtc(null);
      return;
    }
    let cancelled = false;
    fetchBalance(wallet.address, "XCP")
      .then((b) => !cancelled && setXcpBalance(b))
      .catch(() => !cancelled && setXcpBalance("error"));
    fetchBtcFunds(wallet.address)
      .then((f) => !cancelled && setBtc(f))
      .catch(() => !cancelled && setBtc("error"));
    return () => {
      cancelled = true;
    };
  }, [wallet.address, result]);

  // A mint left unfinished in an earlier session.
  useEffect(() => {
    setPending(loadPendingMint());
  }, []);

  const onFile = useCallback(async (picked: File) => {
    setFile(picked);
    setMimeType(guessContentType(picked));
    setBytes(new Uint8Array(await picked.arrayBuffer()));
    setError(null);
  }, []);

  /* ---------------- derived ---------------- */

  const nameCheck = useMemo(() => (asset ? classifyAssetName(asset) : null), [asset]);
  const nameKind = nameCheck?.ok ? nameCheck.kind : asset ? null : "numeric";
  const existing = lookup.state === "done" ? lookup.info : null;
  const isMine = existing !== null && wallet.address !== null && existing.owner === wallet.address;

  /** Why the name, as typed, cannot be minted in this mode — or null. */
  const assetError = useMemo<string | null>(() => {
    if (mode === "reinscribe") {
      if (!asset) return copy.mint.asset.reinscribeNeedsExisting;
      if (nameCheck && !nameCheck.ok) return copy.mint.asset.reasons[nameCheck.reason] ?? copy.mint.asset.invalid;
      if (lookup.state === "error") return copy.mint.asset.lookupFailed;
      if (lookup.state !== "done") return null;
      if (!existing) return copy.mint.asset.reinscribeNeedsExisting;
      if (!isMine) return copy.mint.asset.reinscribeNotYours(existing.owner);
      if (existing.description_locked) return copy.mint.asset.existsLockedDescription;
      return null;
    }
    if (!asset) return null;
    if (nameCheck && !nameCheck.ok) return copy.mint.asset.reasons[nameCheck.reason] ?? copy.mint.asset.invalid;
    if (mode === "fairminter" && nameCheck?.ok && nameCheck.kind === "subasset") return copy.mint.asset.reasons["subasset-parent"];
    if (lookup.state === "error") return copy.mint.asset.lookupFailed;
    if (lookup.state === "done" && existing) {
      if (mode === "fairminter") return copy.mint.asset.xcp69Exists;
      return isMine ? copy.mint.asset.existsYours : copy.mint.asset.existsOther(existing.owner);
    }
    return null;
  }, [asset, existing, isMine, lookup.state, mode, nameCheck]);

  const burnXcp = nameKind === "named" ? issuanceBurnXcp("named") : 0;
  const xcpShort = burnXcp > 0 && typeof xcpBalance === "bigint" && xcpBalance < BigInt(Math.round(burnXcp * 1e8));

  const schedule = useMemo(() => {
    if (mode !== "fairminter" || tip === null) return null;
    // XCP-69 must confirm before it starts; a custom sale may start in its own block (lead 0).
    const lead = preset === "xcp69" ? Math.max(XCP69_MIN_START_LEAD, Number(startLead) || XCP69_DEFAULT_START_LEAD) : Math.max(0, Number(startLead) || 0);
    if (preset === "xcp69") return xcp69Schedule(tip, lead);
    const startBlock = lead > 0 ? tip + lead : 0;
    const window = Math.max(0, Number(sale.window) || 0);
    return { startBlock, deadlineBlock: (startBlock || tip) + window };
  }, [mode, preset, tip, startLead, sale.window]);

  /** The sale as it will be composed, and what is wrong with it. */
  const fairminter = useMemo<{ params: FairminterParams; problems: string[] } | null>(() => {
    if (mode !== "fairminter" || !schedule) return null;
    const params = preset === "xcp69" ? xcp69Params(schedule.startBlock) : saleParams(sale, schedule.startBlock);
    return { params, problems: fairminterProblems(params) };
  }, [mode, preset, sale, schedule]);

  // Before compose, from the file size and the envelope's measured frame; the
  // exact weight comes from Core's composed reveal at mint time.
  const estimate = useMemo(() => {
    if (!bytes || fee.rate === null) return null;
    const e = estimateMint(bytes.length, fee.rate, envelope);
    return { ...e, bytes: bytes.length, nonStandard: e.revealWeight > STANDARD_WITNESS_LIMIT_WU };
  }, [bytes, fee.rate, envelope]);

  const btcShort = typeof btc === "object" && btc !== null && estimate !== null && btc.confirmed < BigInt(estimate.totalSats);

  const walletError = requiresTaproot(wallet.account);
  const ready =
    wallet.address !== null &&
    walletError === null &&
    bytes !== null &&
    !assetError &&
    (mode !== "reinscribe" || (lookup.state === "done" && isMine)) &&
    (mode !== "fairminter" || (fairminter !== null && fairminter.problems.length === 0)) &&
    lookup.state !== "checking" &&
    !xcpShort &&
    fee.ok &&
    stage === null &&
    !result;

  /* ---------------- actions ---------------- */

  const run = useCallback(async () => {
    if (!bytes || !wallet.adapter || !wallet.address || !wallet.publicKey) return;
    setError(null);
    setResult(null);
    const source = wallet.address;

    try {
      const mint = await mintCounter(
        wallet.adapter,
        {
          mode,
          source,
          sourceXOnly: xOnly(wallet.publicKey),
          asset: asset.trim(),
          body: bytes,
          mimeType,
          quantity: BigInt(supply || "0") * (divisible ? XCP_RAW : 1n),
          divisible: fairminter ? fairminter.params.divisible : divisible,
          lockQuantity,
          satPerVbyte: fee.rate ?? 0,
          envelope,
          preset: mode === "fairminter" ? preset : undefined,
          fairminter: fairminter ? { ...fairminter.params, lpAsset: fairminter.params.poolQuantity > 0n ? randomNumericAsset() : undefined } : undefined,
        },
        setStage,
        (psbt, plan) => {
          // Stashed BEFORE the commit is broadcast, and on disk: a mint that
          // fails after this point is recoverable from another session too.
          const saved: PendingMint = {
            source,
            asset: plan.asset,
            commitTxid: plan.commitTxid,
            revealPsbt: psbt,
            plan,
            savedAt: Date.now(),
          };
          savePendingMint(saved);
          setPending(saved);
        },
      );
      clearPendingMint();
      setPending(null);
      setResult(mint);
    } catch (err) {
      if (err instanceof RevealPendingError) {
        setError({ message: err.message, detail: describeError(err.cause).message });
      } else if (err instanceof NonStandardRevealError) {
        setError({ message: err.message, detail: null });
      } else if (isCancellation(err)) {
        setError({ message: copy.errors.cancelled(), detail: null });
      } else {
        setError(describeError(err));
      }
    } finally {
      setStage(null);
    }
  }, [asset, bytes, divisible, envelope, fairminter, fee.rate, lockQuantity, mimeType, mode, preset, supply, wallet.adapter, wallet.address, wallet.publicKey]);

  const resume = useCallback(async () => {
    if (!pending || !wallet.adapter || !wallet.address) return;
    setError(null);
    try {
      const reveal = await finishReveal(wallet.adapter, wallet.address, pending.revealPsbt, setStage);
      clearPendingMint();
      setResult({ ...pending.plan, revealTxid: reveal.txid, revealHex: reveal.hex, revealWeight: reveal.weight, commitBroadcast: pending.commitTxid, revealBroadcast: reveal.txid });
      setPending(null);
    } catch (err) {
      setError(isCancellation(err) ? { message: copy.errors.cancelled(), detail: null } : describeError(err));
    } finally {
      setStage(null);
    }
  }, [pending, wallet.adapter, wallet.address]);

  const discard = useCallback(() => {
    clearPendingMint();
    setPending(null);
  }, []);

  /* ---------------- render ---------------- */

  if (result) {
    return (
      <Receipt
        result={result}
        wantLock={lockDesc && result.mode !== "fairminter"}
        satPerVbyte={fee.rate ?? 1}
      />
    );
  }

  const modeCta = mode === "fairminter" ? copy.mint.ctaFairminter : mode === "reinscribe" ? copy.mint.ctaReinscribe : copy.mint.cta;

  return (
    <div className="flex flex-col gap-5">
      {pending && (
        <div className="rounded-2xl border border-gold/40 bg-gold/5 p-5">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-gold">{copy.mint.pending.label}</p>
          <p className="text-sm text-ink">{copy.mint.pending.body(pending.asset, pending.commitTxid.slice(0, 12))}</p>
          {wallet.address && wallet.address !== pending.source && (
            <p className="mt-2 text-[11px] text-faint">{copy.mint.pending.wrongAddress(pending.source)}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={resume}
              disabled={!wallet.adapter || wallet.address !== pending.source || stage !== null}
              className="rounded-xl border border-gold bg-gold/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-gold disabled:opacity-50"
            >
              {stage ? STAGE_COPY[stage] : copy.mint.pending.resume}
            </button>
            <button onClick={discard} className="rounded-xl border border-line px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-faint">
              {copy.mint.pending.discard}
            </button>
          </div>
        </div>
      )}

      <Well label={copy.mint.modes.label}>
        <div className="flex flex-col gap-2">
          <Choice label={copy.mint.modes.counter} hint={copy.mint.modes.counterHint} active={mode === "counter"} onClick={() => setMode("counter")} />
          <Choice label={copy.mint.modes.reinscribe} hint={copy.mint.modes.reinscribeHint} active={mode === "reinscribe"} onClick={() => setMode("reinscribe")} />
          <Choice label={copy.mint.modes.fairminter} hint={copy.mint.modes.fairminterHint} active={mode === "fairminter"} onClick={() => setMode("fairminter")} />
        </div>
      </Well>

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
              {copy.mint.file.mimeNote} {classifyMimeType(mimeType) === "text" ? copy.mint.file.mimeText : copy.mint.file.mimeBinary}
            </p>
          </div>
        )}
      </Well>

      <Well label={copy.mint.asset.label}>
        <Row label="name">
          <input
            value={asset}
            onChange={(e) => setAsset(e.target.value.toUpperCase().trim())}
            placeholder={mode === "reinscribe" ? copy.mint.asset.namePlaceholderRequired : copy.mint.asset.namePlaceholder}
            className="w-72 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-copper"
          />
        </Row>
        <p className="mt-1.5 text-[11px] text-faint">
          {lookup.state === "checking"
            ? copy.mint.asset.checking
            : mode === "reinscribe" && existing && isMine && !existing.description_locked
              ? copy.mint.asset.reinscribeReady(existing.mime_type ?? null)
              : !asset
                ? copy.mint.asset.numericAuto
                : nameKind === "named"
                  ? copy.mint.asset.named(burnXcp)
                  : nameKind === "subasset" && nameCheck?.ok
                    ? copy.mint.asset.subasset(nameCheck.parent ?? "")
                    : copy.mint.asset.numeric}
        </p>
        {assetError && <p className="mt-1.5 text-[11px] text-bad">{assetError}</p>}

        {mode === "counter" && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line2 pt-3">
            <Row label="supply">
              <input
                value={supply}
                inputMode="numeric"
                onChange={(e) => setSupply(e.target.value.replace(/[^\d]/g, ""))}
                className="w-32 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper"
              />
            </Row>
            <Toggle label="divisible" value={divisible} onChange={setDivisible} />
            <Toggle label="lock supply" value={lockQuantity} onChange={setLockQuantity} />
            <Toggle label={copy.mint.lockDescription.label} value={lockDesc} onChange={setLockDesc} />
            {lockDesc && <p className="text-[11px] text-faint">{copy.mint.lockDescription.hint}</p>}
          </div>
        )}
        {mode === "reinscribe" && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line2 pt-3">
            <Toggle label={copy.mint.lockDescription.label} value={lockDesc} onChange={setLockDesc} />
            {lockDesc && <p className="text-[11px] text-faint">{copy.mint.lockDescription.hint}</p>}
          </div>
        )}
      </Well>

      {mode === "fairminter" && (
        <Well label={copy.mint.presets.label}>
          <div className="flex flex-col gap-2">
            <Choice label={copy.mint.presets.xcp69} hint={copy.mint.presets.xcp69Hint} active={preset === "xcp69"} onClick={() => setPreset("xcp69")} />
            <Choice label={copy.mint.presets.custom} hint={copy.mint.presets.customHint} active={preset === "custom"} onClick={() => setPreset("custom")} />
          </div>

          <div className="mt-4 flex flex-col gap-2 border-t border-line2 pt-3">
            {preset === "custom" && (
              <>
                <Field label={copy.mint.fairminter.lotPrice} value={sale.lotPrice} onChange={(v) => setSaleField("lotPrice", v)} unit="XCP" />
                <Field label={copy.mint.fairminter.lotSize} value={sale.lotSize} onChange={(v) => setSaleField("lotSize", v)} />
                <Field label={copy.mint.fairminter.hardCap} value={sale.hardCap} onChange={(v) => setSaleField("hardCap", v)} hint={copy.mint.fairminter.zeroIsNone} />
                <Field label={copy.mint.fairminter.softCap} value={sale.softCap} onChange={(v) => setSaleField("softCap", v)} hint={copy.mint.fairminter.zeroIsNone} />
                <Field label={copy.mint.fairminter.poolQuantity} value={sale.poolQuantity} onChange={(v) => setSaleField("poolQuantity", v)} hint={copy.mint.fairminter.zeroIsNone} />
                <Field label={copy.mint.fairminter.maxMintPerAddress} value={sale.maxMintPerAddress} onChange={(v) => setSaleField("maxMintPerAddress", v)} hint={copy.mint.fairminter.zeroIsNone} />
                <Field label={copy.mint.fairminter.maxMintPerTx} value={sale.maxMintPerTx} onChange={(v) => setSaleField("maxMintPerTx", v)} hint={copy.mint.fairminter.zeroIsNone} />
                <Field label={copy.mint.fairminter.premint} value={sale.premint} onChange={(v) => setSaleField("premint", v)} />
                <Field label={copy.mint.fairminter.commission} value={sale.commission} onChange={(v) => setSaleField("commission", v)} unit="%" />
                <Toggle label={copy.mint.fairminter.divisible} value={sale.divisible} onChange={(v) => setSaleField("divisible", v)} />
                <Toggle label={copy.mint.fairminter.lockQuantity} value={sale.lockQuantity} onChange={(v) => setSaleField("lockQuantity", v)} />
                <Toggle label={copy.mint.fairminter.lockDescription} value={sale.lockDescription} onChange={(v) => setSaleField("lockDescription", v)} />
                <Toggle label={copy.mint.fairminter.burnPayment} value={sale.burnPayment} onChange={(v) => setSaleField("burnPayment", v)} />
                <p className="text-[11px] leading-relaxed text-faint">{copy.mint.fairminter.poolHint}</p>
              </>
            )}

            <Field label={copy.mint.fairminter.startLead} value={startLead} onChange={setStartLead} unit={copy.mint.fairminter.blocks} integer hint={preset === "xcp69" ? undefined : copy.mint.fairminter.noneNow} />
            {preset === "custom" && (
              <>
                <Field label={copy.mint.fairminter.window} value={sale.window} onChange={(v) => setSaleField("window", v)} unit={copy.mint.fairminter.blocks} integer />
                <Field label={copy.mint.fairminter.endAfter} value={sale.endAfter} onChange={(v) => setSaleField("endAfter", v)} unit={copy.mint.fairminter.blocks} integer hint={copy.mint.fairminter.zeroIsNone} />
              </>
            )}
            {preset === "xcp69" && <p className="text-[11px] leading-relaxed text-faint">{copy.mint.xcp69.leadHint}</p>}
            <p className="font-mono text-[11px] text-dim">
              {schedule
                ? schedule.startBlock > 0
                  ? copy.mint.xcp69.schedule(schedule.startBlock.toLocaleString("en-US"), schedule.deadlineBlock.toLocaleString("en-US"))
                  : copy.mint.fairminter.noneNow
                : copy.mint.xcp69.tipUnknown}
            </p>
          </div>

          <ul className="mt-4 flex flex-col gap-1 border-t border-line2 pt-3 text-[11px] leading-relaxed text-faint">
            {(preset === "xcp69" ? Object.values(copy.mint.xcp69.lines) : saleSummary(fairminter?.params ?? null)).map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-copper">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {fairminter && fairminter.problems.length > 0 && (
            <p className="mt-3 text-[11px] text-bad">
              {copy.mint.fairminter.problems} {fairminter.problems.join("; ")}
            </p>
          )}
          {preset === "xcp69" && <p className="mt-3 text-[11px] leading-relaxed text-faint">{copy.mint.xcp69.listed}</p>}
        </Well>
      )}

      <Well label={copy.mint.envelope.label}>
        <div className="flex flex-col gap-2">
          <Choice label={copy.mint.envelope.native} hint={copy.mint.envelope.nativeHint} active={envelope === "counterparty"} onClick={() => setEnvelope("counterparty")} />
          <Choice label={copy.mint.envelope.ord} hint={copy.mint.envelope.ordHint} active={envelope === "counterparty/ord"} onClick={() => setEnvelope("counterparty/ord")} />
        </div>
        <div className="mt-4 border-t border-line2 pt-3">
          <FeeRateField fee={fee} xcpWallet={wallet.adapter?.id === "xcp"} />
        </div>
      </Well>

      {estimate && (
        <div className="rounded-2xl border border-line bg-card p-5">
          <Row label={copy.mint.estimate.onChain}>
            <span className="font-mono text-xs text-ink">{fmtSize(estimate.bytes)}</span>
          </Row>
          <Row label={copy.mint.estimate.revealWeight}>
            <span className="font-mono text-xs text-ink">~{estimate.revealWeight.toLocaleString("en-US")} WU</span>
          </Row>
          <Row label={copy.mint.estimate.revealFee}>
            <span className="font-mono text-xs text-ink">
              ~{estimate.revealFee.toLocaleString("en-US")} sat
              <span className="ml-2 text-faint">{copy.mint.estimate.effective(formatFeeRate(Math.round(estimate.revealEffective * 1000) / 1000))}</span>
            </span>
          </Row>
          <Row label={copy.mint.estimate.commitFee}>
            <span className="font-mono text-xs text-dim">~{estimate.commitFee.toLocaleString("en-US")} sat</span>
          </Row>
          <Row label={copy.mint.estimate.total}>
            <span className="font-mono text-xs text-ink">~{estimate.totalFee.toLocaleString("en-US")} sat</span>
          </Row>
          {estimate.dustFloored && <p className="mt-2 text-[11px] text-faint">{copy.mint.estimate.dustFloor}</p>}
          {estimate.nonStandard && (
            <p className="mt-3 rounded-lg border border-gold/40 bg-gold/5 p-3 text-[11px] leading-relaxed text-gold">
              {fill(copy.mint.nonStandard)}
            </p>
          )}
        </div>
      )}

      {wallet.address && (
        <div className="rounded-2xl border border-line bg-card p-5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{copy.mint.preflight.label}</div>
          {xcpBalance === null || btc === null ? (
            <p className="text-[11px] text-faint">{copy.mint.preflight.checking}</p>
          ) : xcpBalance === "error" || btc === "error" ? (
            <p className="text-[11px] text-faint">{copy.mint.preflight.unavailable}</p>
          ) : (
            <div className="flex flex-col gap-1 text-[11px]">
              {burnXcp > 0 && (
                <p className={xcpShort ? "text-bad" : "text-dim"}>
                  {xcpShort
                    ? copy.mint.preflight.xcpShort(String(burnXcp), fmtQty(xcpBalance, true))
                    : copy.mint.preflight.xcpOk(String(burnXcp))}
                </p>
              )}
              <p className={btcShort ? "text-gold" : "text-dim"}>
                {btcShort && estimate
                  ? copy.mint.preflight.btcShort(btc.confirmed.toLocaleString("en-US") + " sat", estimate.totalSats.toLocaleString("en-US"))
                  : copy.mint.preflight.btc(fmtQty(btc.confirmed, true))}
              </p>
            </div>
          )}
        </div>
      )}

      {walletError && wallet.address && (
        <div className="rounded-2xl border border-gold/40 bg-gold/5 p-4 text-sm text-gold">{walletError}</div>
      )}

      {error && (
        <div className="rounded-2xl border border-bad/40 bg-bad/5 p-4 text-sm text-bad">
          {error.message}
          {error.detail && error.detail !== error.message && (
            <p className="mt-2 break-words font-mono text-[10px] text-bad/70">{error.detail}</p>
          )}
          {pending && wallet.address === pending.source && (
            <button
              onClick={resume}
              className="mt-3 block rounded-xl border border-copper px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-copper2"
            >
              {copy.mint.pending.resume}
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
          {stage ? STAGE_COPY[stage] : walletError ? copy.mint.ctaTaproot : modeCta}
        </button>
      ) : (
        <ConnectInline />
      )}

      <p className="text-[11px] leading-relaxed text-faint">{copy.mint.footnote}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- */

function Receipt({ result, wantLock, satPerVbyte }: { result: MintResult; wantLock: boolean; satPerVbyte: number }) {
  const wallet = useWallet();
  const [lockState, setLockState] = useState<"waiting" | "ready" | "signing" | "done" | "error">("waiting");
  const [lockTxid, setLockTxid] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const polls = useRef(0);

  // The lock can only be composed once the reveal has confirmed and the
  // asset exists on the node. Polled, gently, for as long as the page is open.
  useEffect(() => {
    if (!wantLock) return;
    let cancelled = false;
    const check = async () => {
      polls.current += 1;
      const info = await fetchAsset(result.asset).catch(() => null);
      if (cancelled) return;
      if (info) setLockState((s) => (s === "waiting" ? "ready" : s));
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [wantLock, result.asset]);

  const lock = useCallback(async () => {
    if (!wallet.adapter || !wallet.address) return;
    setLockState("signing");
    setLockError(null);
    try {
      const txid = await lockDescription(wallet.adapter, wallet.address, result.asset, satPerVbyte);
      setLockTxid(txid);
      setLockState("done");
    } catch (err) {
      setLockError(describeError(err).message);
      setLockState("ready");
    }
  }, [wallet.adapter, wallet.address, result.asset, satPerVbyte]);

  const label = result.mode === "fairminter" ? copy.mint.receipt.labelLaunched : result.mode === "reinscribe" ? copy.mint.receipt.labelReinscribed : copy.mint.receipt.label;
  const start = result.fairminter?.startBlock ?? 0;

  return (
    <div className="rounded-2xl border border-patina/40 bg-patina/5 p-6">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-patina">{label}</p>
      <h2 className="mb-4 font-mono text-2xl text-ink">{result.asset}</h2>
      <p className="mb-5 text-sm text-dim">
        {result.mode === "fairminter"
          ? copy.mint.receipt.bodyFairminter(start > 0 ? start.toLocaleString("en-US") : null, result.preset === "xcp69")
          : copy.mint.receipt.body}
      </p>
      <div className="flex flex-col gap-2">
        <Row label="commit">
          <a href={mempoolTxUrl(result.commitBroadcast)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-copper2 underline-offset-2 hover:underline">
            {result.commitBroadcast.slice(0, 16)}…
          </a>
        </Row>
        <Row label="reveal">
          <a href={mempoolTxUrl(result.revealBroadcast)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-copper2 underline-offset-2 hover:underline">
            {result.revealBroadcast.slice(0, 16)}…
          </a>
        </Row>
        <Row label={copy.mint.estimate.commitFee}>
          <span className="font-mono text-xs text-dim">
            {result.commitFee.toLocaleString("en-US")} sat
            {result.commitVsize > 0 && (
              <span className="ml-2 text-faint">{copy.mint.estimate.effective(formatFeeRate(Math.round(effectiveRate(result.commitFee, result.commitVsize) * 1000) / 1000))}</span>
            )}
          </span>
        </Row>
        <Row label={copy.mint.estimate.revealWeightExact}>
          <span className="font-mono text-xs text-ink">{result.revealWeight.toLocaleString("en-US")} WU</span>
        </Row>
        <Row label="reveal fee">
          <span className="font-mono text-xs text-dim">
            {result.revealFee.toLocaleString("en-US")} sat
            <span className="ml-2 text-faint">{copy.mint.estimate.effective(formatFeeRate(Math.round(effectiveRate(result.revealFee, vbytesOf(result.revealWeight)) * 1000) / 1000))}</span>
          </span>
        </Row>
        <Row label={copy.mint.estimate.total}>
          <span className="font-mono text-xs text-ink">{result.totalFee.toLocaleString("en-US")} sat</span>
        </Row>
        {result.fairminter?.lpAsset && (
          <Row label={copy.mint.xcp69.lpAsset}>
            <span className="font-mono text-xs text-dim">{result.fairminter.lpAsset}</span>
          </Row>
        )}
        {result.mode === "fairminter" && result.preset === "xcp69" && (
          <a href={`https://xcp.fun/${result.asset}`} target="_blank" rel="noreferrer noopener" className="mt-1 font-mono text-xs text-copper2 underline-offset-2 hover:underline">
            {copy.mint.receipt.xcpFun} →
          </a>
        )}
      </div>

      {wantLock && (
        <div className="mt-5 border-t border-line2 pt-4">
          <p className="mb-2 text-[11px] text-faint">{copy.mint.receipt.lockDescription.hint}</p>
          {lockState === "done" && lockTxid ? (
            <a href={mempoolTxUrl(lockTxid)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-patina underline-offset-2 hover:underline">
              {copy.mint.receipt.lockDescription.done} · {lockTxid.slice(0, 12)}…
            </a>
          ) : (
            <button
              onClick={lock}
              disabled={lockState !== "ready"}
              className="rounded-xl border border-copper px-4 py-2 font-mono text-xs uppercase tracking-[0.1em] text-copper2 disabled:border-line disabled:text-faint"
            >
              {lockState === "waiting"
                ? copy.mint.receipt.lockDescription.waiting
                : lockState === "signing"
                  ? copy.mint.receipt.lockDescription.signing
                  : copy.mint.receipt.lockDescription.cta}
            </button>
          )}
          {lockError && <p className="mt-2 text-[11px] text-bad">{lockError}</p>}
        </div>
      )}
    </div>
  );
}

function FileDrop({ file, bytes, onFile }: { file: File | null; bytes: Uint8Array | null; onFile: (f: File) => void }) {
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
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">{label}</div>
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

function Field({ label, value, onChange, unit, hint, integer = false }: { label: string; value: string; onChange: (v: string) => void; unit?: string; hint?: string; integer?: boolean }) {
  return (
    <div>
      <Row label={label}>
        <span className="flex items-center gap-1.5">
          <input
            value={value}
            inputMode={integer ? "numeric" : "decimal"}
            onChange={(e) => onChange(e.target.value.replace(integer ? /[^\d]/g : /[^\d.]/g, ""))}
            className="w-32 rounded-lg border border-line bg-bg2 px-2 py-1 text-right font-mono text-xs text-ink outline-none focus:border-copper"
          />
          {unit && <span className="w-10 font-mono text-[11px] text-faint">{unit}</span>}
        </span>
      </Row>
      {hint && <p className="-mt-0.5 text-right text-[10px] text-faint">{hint}</p>}
    </div>
  );
}

/** What a custom sale amounts to, in sentences. */
function saleSummary(p: FairminterParams | null): string[] {
  if (!p) return [];
  const c = copy.mint.fairminter.summary;
  const lines: string[] = [];
  const scale = p.divisible ? 100_000_000n : 1n;
  if (p.lotPrice > 0n && p.lotSize > 0n && p.softCap > 0n) {
    const raise = (p.softCap * p.lotPrice) / p.lotSize;
    lines.push(c.raise(fmtQty(raise, true)));
  } else if (p.lotPrice === 0n) {
    lines.push(c.free);
  }
  if (p.poolQuantity > 0n) lines.push(c.pool(fmtQty(p.poolQuantity, p.divisible)));
  else if (p.burnPayment) lines.push(c.burn);
  else lines.push(c.noPool);
  lines.push(`${p.lockQuantity ? "supply locked" : "supply unlocked"} · ${p.lockDescription ? "description locked" : "description unlocked"} · ${p.divisible ? "divisible" : "indivisible"}`);
  if (p.premintQuantity > 0n) lines.push(`${fmtQty(p.premintQuantity, p.divisible)} preminted to you`);
  void scale;
  return lines;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label}>
      <button
        onClick={() => onChange(!value)}
        className={`rounded-lg border px-3 py-1 font-mono text-[11px] transition-colors ${value ? "border-copper text-copper2" : "border-line text-faint"}`}
      >
        {value ? "yes" : "no"}
      </button>
    </Row>
  );
}

function Choice({ label, hint, active, onClick }: { label: string; hint: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-copper bg-copper-ghost" : "border-line hover:border-line2"}`}
    >
      <div className={`font-mono text-xs ${active ? "text-copper2" : "text-dim"}`}>{label}</div>
      <div className="mt-0.5 text-[11px] text-faint">{hint}</div>
    </button>
  );
}
