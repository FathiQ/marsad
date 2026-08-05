import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  CircleHelp,
  Loader2,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchGraph,
  simulate,
  type Decision,
  type GraphNode,
  type SimEndpoint,
  type SimResult,
  type Verdict,
} from "../api";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** What the user typed, before it is resolved to an endpoint. */
export interface Endpoint {
  text: string;
  /** Set when the text came from picking a workload out of the graph. */
  workload?: { namespace: string; name: string; kind?: string };
}

export interface Prefill {
  from?: Endpoint;
  to?: Endpoint;
  port?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: Prefill;
}

const CIDR = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/;

/**
 * Turns what the user typed into the endpoint shape the API takes.
 *
 * A picked workload is unambiguous. Free text is not, so it is classified the
 * way a person would read it: something that parses as an address is an address,
 * and anything else is a domain. The classification is shown back to them rather
 * than applied silently.
 */
export function resolveEndpoint(
  ep: Endpoint,
): { value: SimEndpoint; label: string } | null {
  if (ep.workload) {
    return {
      value: {
        namespace: ep.workload.namespace,
        name: ep.workload.name,
        kind: ep.workload.kind,
      },
      label: "workload",
    };
  }
  const text = ep.text.trim();
  if (!text) return null;
  if (CIDR.test(text) && text.includes(":") !== text.includes(".")) {
    return { value: { cidr: text }, label: "address" };
  }
  return { value: { domain: text }, label: "domain" };
}

function EndpointField({
  id,
  label,
  value,
  onChange,
  nodes,
}: {
  id: string;
  label: string;
  value: Endpoint;
  onChange: (ep: Endpoint) => void;
  nodes: GraphNode[];
}) {
  const [openList, setOpenList] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const text = value.text.trim().toLowerCase();
    return nodes
      .filter((n) => n.kind === "workload" || n.kind === "domain")
      .map((n) => ({
        node: n,
        display: n.kind === "workload" ? `${n.namespace}/${n.label}` : n.label,
      }))
      .filter((o) => !text || o.display.toLowerCase().includes(text))
      .slice(0, 8);
  }, [nodes, value.text]);

  useEffect(() => {
    if (!openList) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node))
        setOpenList(false);
    };
    // Deferred a tick: the click that opened the list would otherwise close it.
    const t = window.setTimeout(
      () => window.addEventListener("mousedown", onDown),
      0,
    );
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [openList]);

  const resolved = resolveEndpoint(value);

  return (
    <div className="relative" ref={box}>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[11px] font-medium text-faint"
      >
        {label}
      </label>
      <input
        id={id}
        value={value.text}
        autoComplete="off"
        spellCheck={false}
        placeholder="namespace/workload, a domain, or an address"
        onChange={(e) => {
          onChange({ text: e.target.value });
          setOpenList(true);
        }}
        onFocus={() => setOpenList(true)}
        onKeyDown={(e) => {
          // Radix closes the dialog on Escape. When a suggestion list is open
          // that is never what was meant, so the list swallows the first one.
          if (e.key === "Escape" && openList) {
            e.stopPropagation();
            setOpenList(false);
          }
        }}
        className={cn(
          "h-9 w-full rounded-lg border border-line bg-bg px-3 text-[13px] text-fg",
          "outline-none placeholder:text-faint focus:border-accent/60",
        )}
      />
      {resolved && !value.workload && (
        <span className="absolute top-[30px] right-2.5 text-[10.5px] text-faint">
          read as a {resolved.label}
        </span>
      )}

      {openList && options.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-elevated p-1 shadow-2xl">
          {options.map((o) => (
            <li key={o.node.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-accent/15 hover:text-fg"
                onMouseDown={(e) => {
                  // mousedown, not click: the outside handler fires first
                  // otherwise and the list is gone before the click lands.
                  e.preventDefault();
                  onChange(
                    o.node.kind === "workload"
                      ? {
                          text: o.display,
                          workload: {
                            namespace: o.node.namespace ?? "",
                            name: o.node.label,
                            kind: o.node.workloadKind,
                          },
                        }
                      : { text: o.display },
                  );
                  setOpenList(false);
                }}
              >
                <span className="truncate">{o.display}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-faint">
                  {o.node.kind === "workload" ? o.node.workloadKind : "domain"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TONE: Record<
  SimResult,
  { tone: "ok" | "danger" | "warn" | "neutral"; text: string }
> = {
  allowed: { tone: "ok", text: "allowed" },
  denied: { tone: "danger", text: "denied" },
  undecidable: { tone: "warn", text: "undecidable" },
  "not-applicable": { tone: "neutral", text: "not applicable" },
};

/**
 * One direction's answer.
 *
 * Both halves are always shown, even when one of them settles the question,
 * because "the source may leave but the destination will not accept" and "the
 * destination would accept but the source may not leave" call for edits to
 * different policies in different namespaces.
 */
function Half({ title, decision }: { title: string; decision: Decision }) {
  const tone = TONE[decision.result] ?? TONE["not-applicable"];
  const layers = Object.entries(decision.byLayer ?? {});

  return (
    <section
      className={cn(
        "rounded-xl border p-3.5",
        decision.result === "denied"
          ? "border-danger/40 bg-danger/5"
          : "border-line bg-bg",
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h4 className="text-[10.5px] font-semibold tracking-[0.07em] text-faint uppercase">
          {title}
        </h4>
        <Badge tone={tone.tone}>{tone.text}</Badge>
      </header>

      <p className="mt-2 text-[12.5px] leading-relaxed break-words text-muted">
        {decision.explain}
      </p>

      {layers.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {layers.map(([provider, result]) => (
            <Badge key={provider} tone={TONE[result]?.tone ?? "neutral"}>
              {provider} · {TONE[result]?.text ?? result}
            </Badge>
          ))}
        </div>
      )}

      {decision.via &&
        decision.via.length > 0 &&
        !decision.via.every((v) => decision.explain.includes(v)) && (
          <div className="mt-2.5 space-y-1 border-t border-dashed border-line pt-2.5">
            {decision.via.map((v) => (
              <code
                key={v}
                className="block font-mono text-[10.5px] break-all text-faint"
              >
                {v}
              </code>
            ))}
          </div>
        )}
    </section>
  );
}

function Headline({ verdict }: { verdict: Verdict }) {
  const { tone, Icon, title } = verdict.undecidable
    ? { tone: "warn" as const, Icon: CircleHelp, title: "Cannot be decided" }
    : verdict.allowed
      ? { tone: "ok" as const, Icon: ShieldCheck, title: "Allowed" }
      : { tone: "danger" as const, Icon: ShieldX, title: "Denied" };

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3.5",
        tone === "ok" && "border-allowed/40 bg-allowed/10",
        tone === "danger" && "border-danger/40 bg-danger/10",
        tone === "warn" && "border-warn/40 bg-warn/10",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-5 shrink-0",
          tone === "ok" && "text-allowed",
          tone === "danger" && "text-danger",
          tone === "warn" && "text-warn",
        )}
      />
      <div className="min-w-0">
        <p
          className={cn(
            "text-[14px] font-semibold",
            tone === "ok" && "text-allowed",
            tone === "danger" && "text-danger",
            tone === "warn" && "text-warn",
          )}
        >
          {title}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed break-words text-muted">
          {verdict.summary.replace(/^(ALLOWED|DENIED|UNDECIDABLE): /, "")}
        </p>
      </div>
    </div>
  );
}

const blank: Endpoint = { text: "" };

export function SimulatePanel({ open, onOpenChange, prefill }: Props) {
  // The panel needs workloads whatever the graph is currently showing, and at
  // namespace level the graph has none. Fetched once on first open rather than
  // held by the app, so a panel nobody opens costs nothing.
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  useEffect(() => {
    if (!open || nodes.length) return;
    let cancelled = false;
    fetchGraph({ level: "workload", namespaces: [], includeDefault: true })
      .then((r) => !cancelled && setNodes(r.graph.nodes))
      .catch(() => {
        // Only the autocomplete is lost; the fields still take free text.
      });
    return () => {
      cancelled = true;
    };
  }, [open, nodes.length]);

  const [from, setFrom] = useState<Endpoint>(blank);
  const [to, setTo] = useState<Endpoint>(blank);
  const [protocol, setProtocol] = useState("TCP");
  const [port, setPort] = useState("443");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Reset on open rather than on close, so the previous answer does not flash
  // away while the dialog is still animating out.
  useEffect(() => {
    if (!open) return;
    setFrom(prefill?.from ?? blank);
    setTo(prefill?.to ?? blank);
    if (prefill?.port) setPort(String(prefill.port));
    setVerdict(null);
    setError(null);
  }, [open, prefill]);

  const fromEP = resolveEndpoint(from);
  const toEP = resolveEndpoint(to);
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const ready = Boolean(fromEP && toEP && portOk);

  const run = () => {
    if (!fromEP || !toEP || !portOk) return;
    setRunning(true);
    setError(null);
    simulate({ from: fromEP.value, to: toEP.value, protocol, port: portNum })
      .then((v) => {
        setVerdict(v);
        setError(null);
      })
      .catch((e: Error) => {
        setVerdict(null);
        setError(e.message);
      })
      .finally(() => setRunning(false));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(42rem,94vw)] -translate-x-1/2 -translate-y-1/2",
            "max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-elevated shadow-2xl outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5">
            <div>
              <Dialog.Title className="text-[14px] font-semibold tracking-tight">
                Would this connection be allowed?
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[11.5px] text-faint">
                Answered from declared policy. Marsad never sends a packet or
                reads one.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </header>

          <form
            className="space-y-3.5 px-4 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2.5">
              <EndpointField
                id="sim-from"
                label="From"
                value={from}
                onChange={setFrom}
                nodes={nodes}
              />
              <ArrowRight className="mb-2.5 size-4 shrink-0 text-faint" />
              <EndpointField
                id="sim-to"
                label="To"
                value={to}
                onChange={setTo}
                nodes={nodes}
              />
            </div>

            <div className="flex flex-wrap items-end gap-2.5">
              <div>
                <span className="mb-1.5 block text-[11px] font-medium text-faint">
                  Protocol
                </span>
                <ToggleGroup
                  type="single"
                  value={protocol}
                  onValueChange={(v) => v && setProtocol(v)}
                >
                  {["TCP", "UDP", "SCTP"].map((p) => (
                    <ToggleGroupItem key={p} value={p}>
                      {p}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div>
                <label
                  htmlFor="sim-port"
                  className="mb-1.5 block text-[11px] font-medium text-faint"
                >
                  Port
                </label>
                <input
                  id="sim-port"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) =>
                    setPort(e.target.value.replace(/\D/g, "").slice(0, 5))
                  }
                  className={cn(
                    "num h-9 w-24 rounded-lg border bg-bg px-3 text-[13px] text-fg outline-none",
                    portOk
                      ? "border-line focus:border-accent/60"
                      : "border-danger/60",
                  )}
                />
              </div>

              <Button
                type="submit"
                variant="default"
                size="md"
                disabled={!ready || running}
                className="ml-auto h-9"
              >
                {running && <Loader2 className="animate-spin" />}
                Check
              </Button>
            </div>
          </form>

          {error && (
            <p className="mx-4 mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[12.5px] text-danger">
              {error}
            </p>
          )}

          {verdict && (
            <div className="space-y-2.5 border-t border-line px-4 py-4">
              <Headline verdict={verdict} />
              <Half
                title="Egress · may the source leave"
                decision={verdict.egress}
              />
              <Half
                title="Ingress · will the destination accept"
                decision={verdict.ingress}
              />
              <p className="pt-0.5 text-[11px] leading-relaxed text-faint">
                Both halves must permit a connection for it to work. Checking
                only one is the usual way reading policy by hand goes wrong, so
                both are always shown — including the one that is not in doubt.
              </p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
