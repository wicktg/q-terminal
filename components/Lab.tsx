"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { UniverseCoin } from "@/lib/types.ts";
import type { LabRead } from "@/lib/lab-live.ts";
import { fmtPct, fmtPx, toneClass } from "@/lib/format.ts";
import { PEERS, PLAYBOOK, RULES } from "@/lib/lab-playbook.ts";
import { LAB_META, LAB_SETUPS } from "@/lib/lab-record.ts";

const Chart = dynamic(() => import("./Chart"), { ssr: false });
const COINS = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "ENA", "LIT", "DOGE", "SUI", "LINK", "1000PEPE", "AERO", "VVV", "UNI"];
const TABS = ["LIVE", "PLAYBOOK", "SCAN", "RESULTS", "RULES"] as const;
type Tab = (typeof TABS)[number];

function useJson<T>(url: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    setData(null);
    const go = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error();
        const j = (await r.json()) as T;
        if (!dead) {
          setData(j);
          setErr(false);
        }
      } catch {
        if (!dead) setErr(true);
      }
    };
    go();
    const id = setInterval(go, ms);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [url, ms]);
  return { data, err };
}

const Wait = ({ err }: { err?: boolean }) => <div className="note">{err ? "Feed unavailable. Retrying." : "Loading…"}</div>;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;

function Panel({ d }: { d: LabRead | null }) {
  if (!d) return <Wait />;
  return (
    <>
      <div className="h">RANGES<span>{fmtPx(d.price)}</span></div>
      {d.ranges.length ? d.ranges.map((r) => (
        <div className="sig" key={r.tf}>
          <div className="k"><i>{r.tf} at {r.at.toLowerCase()}</i><span className={r.where === "INSIDE" ? "amber" : "dim"}>{r.where.toLowerCase()}</span></div>
          <div className="n">{fmtPx(r.lo)} – {fmtPx(r.hi)}, after impulse {r.impulse.toLowerCase()}. {r.plan}</div>
        </div>
      )) : <div className="note">No valid range at a swing extreme on any timeframe. Sit on your hands.</div>}
    </>
  );
}

function Results() {
  const lanes = ["LTF", "HTF"];
  return (
    <>
      <div className="note proof"><b>{LAB_META.best >= 12 ? "PASSED." : "NOT PROVEN."}</b> {LAB_META.verdict}</div>
      {lanes.map((l) => (
        <div key={l}>
          <div className="h">{l} SETUPS<span>{LAB_META.period}, after fees and funding, settings chosen on older data</span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead><tr><th>Setup</th><th>TF</th><th className="r">Older</th><th className="r">Unseen months</th><th className="r">UNI + AERO</th><th className="r">Last 30D</th><th className="r">Gates</th><th>Failed</th></tr></thead>
              <tbody>
                {LAB_SETUPS.filter((s) => s.lane === l).map((s) => (
                  <tr key={s.key}>
                    <td>{PLAYBOOK.find((p) => p.fam === s.fam)?.title}</td>
                    <td className="dim">{s.tf.toUpperCase()}</td>
                    <td className={`r ${toneClass(s.older)}`}>{signed(s.older)} <span className="dim">({s.n})</span></td>
                    <td className={`r ${toneClass(s.unseen)}`}>{signed(s.unseen)} <span className="dim">({s.unseenN})</span></td>
                    <td className={`r ${toneClass(s.hold)}`}>{signed(s.hold)} <span className="dim">({s.holdN})</span></td>
                    <td className={`r ${toneClass(s.last30)}`}>{signed(s.last30)} <span className="dim">({s.last30N})</span></td>
                    <td className="r amber">{s.gates ? `${s.gates}/12` : "—"}</td>
                    <td className="dim" style={{ whiteSpace: "normal", minWidth: 180 }}>{s.failed.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="note">Gates shows — when a setup never reached them, because it missed the first bar on older data. His M1 entries are tested on 5M, the shortest bars available. FOMC days and his loss limits are not modelled. This is a test area, not advice.</div>
    </>
  );
}

function Playbook() {
  return (
    <>
      <div className="note proof">Rules taken from <a className="amber" href="https://x.com/tradermatt" target="_blank" rel="noreferrer noopener">@tradermatt</a>&apos;s public posts, 1–30 October 2026, written so a computer can test them.</div>
      <div className="grid2 lab-grid">
        {PLAYBOOK.map((p) => (
          <div className="card" key={p.fam}>
            <div className="verdict"><div className="tag">{p.tag}</div><div style={{ fontSize: 15 }}>{p.title}</div></div>
            <div className="note plan">{p.idea}</div>
            <table className="stat"><tbody>{p.steps.map((s) => <tr key={s.label}><td style={{ verticalAlign: "top" }}>{s.label}</td><td style={{ textAlign: "left", whiteSpace: "normal" }}>{s.text}</td></tr>)}</tbody></table>
            <div className="note">Source: {p.source.map((u, i) => <a key={u} className="dim" href={u} target="_blank" rel="noreferrer noopener">post {i + 1}{i < p.source.length - 1 ? ", " : ""}</a>)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Rules() {
  const row = (x: { label: string; text: string }, i: number) => <tr key={i}><td style={{ verticalAlign: "top" }}>{x.label}</td><td style={{ textAlign: "left", whiteSpace: "normal" }}>{x.text}</td></tr>;
  return (
    <>
      <div className="h">HIS TRADING RULES</div>
      <table className="stat"><tbody>{RULES.map(row)}</tbody></table>
      <div className="h">OPINIONS MIXED IN<span>same lane, from their own posts</span></div>
      <table className="stat"><tbody>{PEERS.map(row)}</tbody></table>
      <div className="note">Posts are public and self-reported. He promotes a Blofin affiliate link, and shared wins are selected, so none of this is an audited record.</div>
    </>
  );
}

function Scan({ onPick }: { onPick: (s: string) => void }) {
  const { data, err } = useJson<LabRead[]>(`/api/lab?syms=${COINS.join(",")}`, 90000);
  if (!data) return <Wait err={err} />;
  const rows = [...data].sort((a, b) => b.ranges.length - a.ranges.length);
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl">
        <thead><tr><th>Coin</th><th className="r">Price</th><th>Ranges</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.sym} className="click" onClick={() => onPick(d.sym)}>
              <td style={{ color: "#fff" }}>{d.sym}</td>
              <td className="r">{fmtPx(d.price)}</td>
              <td className="dim">{d.ranges.map((r) => r.tf).join(" ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Lab() {
  const [sym, setSym] = useState("BTC");
  const [tab, setTab] = useState<Tab>("LIVE");
  const [live, setLive] = useState<number | null>(null);
  const { data: uni } = useJson<UniverseCoin[]>("/api/universe", 15000);
  const { data: rows } = useJson<LabRead[]>(`/api/lab?sym=${sym}`, 30000);
  const d = rows?.[0]?.sym === sym ? rows[0] : null;
  const byS = useMemo(() => new Map(uni?.map((u) => [u.sym, u]) ?? []), [uni]);
  const u = byS.get(sym);
  const marks = useMemo(() => (d?.ranges ?? []).flatMap((r) => [{ price: r.hi, label: `${r.tf} range high` }, { price: r.lo, label: `${r.tf} range low` }]), [d]);
  const pick = (s: string) => {
    setSym(s);
    setLive(null);
    setTab("LIVE");
  };
  return (
    <div className="app lab">
      <header className="topbar">
        <span className="brand">Q LAB</span>
        <span className="sym">{sym}</span>
        <span className="price">{live ?? u?.price ? fmtPx(live ?? u?.price ?? 0) : "—"}</span>
        <span className={toneClass(u?.chg24h)}>{fmtPct(u?.chg24h)}</span>
        <span className="status">TEST AREA · <Link className="amber" href="/">MAIN TERMINAL</Link></span>
      </header>
      <nav className="tabs">
        {TABS.map((t, i) => <button key={t} className="tab" data-on={t === tab} onClick={() => setTab(t)}><kbd>{i + 1}</kbd>{t}</button>)}
      </nav>
      <div className="body">
        <aside className="side">
          <div className="wl">
            {COINS.map((c) => {
              const x = byS.get(c);
              return (
                <div key={c} className="wl-row" data-on={c === sym} role="button" tabIndex={0} onClick={() => pick(c)} onKeyDown={(e) => e.key === "Enter" && pick(c)}>
                  <span className="n">{c}</span>
                  <span>{x ? fmtPx(x.price) : "—"}</span>
                  <span className={toneClass(x?.chg24h)} style={{ minWidth: 52, textAlign: "right" }}>{fmtPct(x?.chg24h, 1)}</span>
                </div>
              );
            })}
          </div>
        </aside>
        <main className={`main ${tab === "LIVE" ? "fill" : ""}`}>
          {tab === "LIVE" && (
            <>
              <Chart sym={sym} analysis={null} onPrice={setLive} marks={marks} />
              <div className="ctx-inline"><Panel d={d} /></div>
            </>
          )}
          {tab === "PLAYBOOK" && <Playbook />}
          {tab === "SCAN" && <Scan onPick={pick} />}
          {tab === "RESULTS" && <Results />}
          {tab === "RULES" && <Rules />}
        </main>
        <section className="ctx"><Panel d={d} /></section>
      </div>
      <nav className="mob-nav">
        {TABS.map((t) => <button key={t} data-on={t === tab} onClick={() => setTab(t)}>{t === "PLAYBOOK" ? "BOOK" : t === "RESULTS" ? "TEST" : t}</button>)}
      </nav>
    </div>
  );
}
