import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from "@xmldom/xmldom";

/*
 * Deterministic facts about an OIC integration archive.
 *
 * Models reviewing an IAR missed different mechanical findings on every run —
 * one saw the discarded response, another the hardcoded endpoint, none saw all —
 * and the worst errors were OIC semantics they did not know (a schedule
 * parameter persists between runs, a global variable does not). Everything here
 * is read from project.xml, expr.properties, XSL, JCA, app instances and DVMs,
 * so the review starts from what the archive provably does and the model's job
 * becomes explaining and prioritising it.
 *
 * Facts, not verdicts: each says what the archive does and the mechanical
 * consequence. Whether it is a defect depends on intent the archive cannot show.
 */

export interface OicFact {
  rule: string;
  path: string;
  message: string;
}

interface Source {
  path: string;
  text: string;
}

type El = XmlElement;

const children = (el: El, name?: string) =>
  Array.from(el.childNodes).filter(
    (n): n is El => n.nodeType === 1 && (!name || (n as El).localName === name),
  );
const child = (el: El, name: string) => children(el, name)[0];
const text = (el: El | undefined) => el?.textContent?.trim() ?? "";
const all = (root: XmlDocument | El, name: string) =>
  Array.from(root.getElementsByTagName("*")).filter((e) => name === "*" || e.localName === name);

/** `Key : value` lines, as OIC writes expr.properties. */
function properties(source: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (source ?? "").split("\n")) {
    const at = line.indexOf(" :");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 2).trim();
  }
  return out;
}

const quote = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max)}…` : s);

export function analyzeOic(sources: Source[]): OicFact[] {
  const projectFile = sources.find((s) => /(?:^|\/)PROJECT-INF\/project\.xml$/i.test(s.path));
  if (!projectFile) return [];
  const base = projectFile.path.replace(/PROJECT-INF\/project\.xml$/i, "");
  const byPath = new Map(sources.map((s) => [s.path, s.text]));
  const at = (location: string | null) =>
    location ? byPath.get(base + location.replace(/^\.\.\//, "")) : undefined;

  let doc: XmlDocument;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(projectFile.text, "application/xml");
  } catch {
    return [];
  }
  const facts: OicFact[] = [];
  const fact = (rule: string, message: string, path = projectFile.path) => facts.push({ rule, path, message });

  /* -- Processors, applications and the variables they write ----------- */
  const processors = new Map(all(doc, "processor").map((p) => [p.getAttribute("name")!, p]));
  const exprOf = (owner: El) =>
    properties(at(all(owner, "resource").find((r) => /expr\.properties$/.test(r.getAttribute("location") ?? ""))?.getAttribute("location") ?? null));

  /** messageContext → readers (processor names) */
  const readers = new Map<string, Set<string>>();
  for (const [name, p] of processors) {
    for (const ref of [...all(p, "resourceRef"), ...all(p, "input").flatMap((i) => all(i, "messageContextRef"))]) {
      const mc = ref.getAttribute("refUri");
      if (!mc) continue;
      if (!readers.has(mc)) readers.set(mc, new Set());
      readers.get(mc)!.add(name);
    }
  }

  interface Variable { name: string; mc: string; writers: string[]; schedule: boolean }
  const variables = new Map<string, Variable>();
  const write = (mc: string, name: string, writer: string, schedule: boolean) => {
    const v = variables.get(mc) ?? { name, mc, writers: [], schedule: false };
    v.writers.push(writer);
    v.schedule ||= schedule;
    if (!v.name) v.name = name;
    variables.set(mc, v);
  };
  for (const [name, p] of processors) {
    const type = text(child(p, "type"));
    if (type === "scheduleReceive") {
      for (const out of children(p, "output").filter((o) => text(child(o, "role")) === "variable")) {
        const mc = child(out, "messageContextRef")?.getAttribute("refUri");
        const variable = exprOf(out).VariableName;
        if (mc && variable) write(mc, variable, name, true);
      }
    } else if (type === "assignment") {
      const mc = child(children(p, "output")[0] ?? p, "messageContextRef")?.getAttribute("refUri");
      const variable = exprOf(p).VariableName;
      if (mc && variable) write(mc, variable, name, false);
    }
  }

  /* -- Orchestration order --------------------------------------------- */
  const orchestration = all(doc, "orchestration")[0];
  const order: string[] = [];
  const position = new Map<string, number>();
  const describe = new Map<string, string>();
  if (orchestration) {
    for (const el of all(orchestration, "*")) {
      const ref = el.getAttribute("refUri")?.split("/")[0];
      if (!ref || position.has(ref)) continue;
      position.set(ref, order.length);
      order.push(ref);
      const id = el.getAttribute("id");
      const label = el.getAttribute("name");
      describe.set(ref, `${el.localName} ${id ?? ref}${label ? ` "${label}"` : ""} (${ref})`);
    }
  }
  const step = (ref: string) => describe.get(ref) ?? ref;
  const labelOf = (ref: string) => {
    const node = orchestration && all(orchestration, "*").find((e) => e.getAttribute("refUri") === ref);
    for (let up = node?.parentNode as El | null; up && up.nodeType === 1; up = up.parentNode as El | null) {
      if (up.localName === "label") return ` in label "${up.getAttribute("name")}"`;
    }
    return "";
  };

  /* -- Variables: read before written, never read, schedule parameters - */
  const scheduleParams = [...variables.values()].filter((v) => v.schedule);
  const paramNames = scheduleParams.map((v) => v.name);
  if (scheduleParams.length) {
    fact(
      "schedule-parameters",
      `Schedule parameters (the only variables whose values persist from one run to the next): ${paramNames.join(", ")}.` +
        ` Default values in this export: ${scheduleParams.map((v) => {
          const out = all(processors.get(v.writers[0]!)!, "output").find((o) => child(o, "messageContextRef")?.getAttribute("refUri") === v.mc);
          return `${v.name}=${out && exprOf(out).XpathExpression ? quote(exprOf(out).XpathExpression!) : "(empty)"}`;
        }).join(", ")}.`,
    );
  }
  for (const v of variables.values()) {
    const read = [...(readers.get(v.mc) ?? [])].filter((r) => !v.writers.includes(r) && position.has(r));
    const assigned = v.writers.filter((w) => text(child(processors.get(w)!, "type")) === "assignment");
    if (v.schedule) {
      if (!read.length) fact("schedule-parameter-unread", `Schedule parameter ${v.name} is never read by any step of the flow.`);
      for (const w of assigned) {
        fact("schedule-parameter-updated", `Schedule parameter ${v.name} is updated by ${step(w)}${labelOf(w)}; as a schedule parameter, that value persists and becomes the input of the next run.`);
      }
      continue;
    }
    if (!read.length) {
      fact("variable-unread", `Variable ${v.name} is assigned by ${v.writers.map(step).join(", ")} and never read.`);
      continue;
    }
    const firstWrite = Math.min(...v.writers.map((w) => position.get(w) ?? Infinity));
    const early = read.filter((r) => position.get(r)! < firstWrite);
    if (early.length) {
      fact(
        "variable-read-before-assigned",
        `Variable ${v.name} is read by ${early.map(step).join(", ")} before its first assignment (${v.writers.map((w) => `${step(w)}${labelOf(w)}`).join(", ")}).` +
          ` It is not a schedule parameter, so it is empty at that point on every run and the value assigned later does not persist to the next run.` +
          (paramNames.length ? ` The schedule parameters are ${paramNames.join(", ")}.` : ""),
      );
    }
  }

  /* -- Routers without a default route --------------------------------- */
  for (const router of orchestration ? all(orchestration, "router") : []) {
    const routes = children(router, "route");
    const conditions = routes.map((r) => {
      const [proc, output] = (r.getAttribute("refUri") ?? "").split("/");
      const out = processors.get(proc ?? "") && children(processors.get(proc!)!, "output").find((o) => o.getAttribute("name") === output);
      return out ? exprOf(out).XpathExpression ?? "" : "";
    });
    if (routes.length && conditions.every(Boolean)) {
      const next = (() => {
        for (let el: El | null = router; el; el = el.parentNode as El | null) {
          let sib = el.nextSibling;
          while (sib && sib.nodeType !== 1) sib = sib.nextSibling;
          if (sib) return describe.get((sib as El).getAttribute("refUri")?.split("/")[0] ?? "") ?? `${(sib as El).localName} ${(sib as El).getAttribute("id") ?? ""}${(sib as El).getAttribute("name") ? ` "${(sib as El).getAttribute("name")}"` : ""}`.trim();
          if (el.parentNode && (el.parentNode as El).localName === "orchestration") return null;
        }
        return null;
      })();
      const ref = router.getAttribute("refUri") ?? "";
      fact(
        "router-without-default",
        `Router ${router.getAttribute("id")} (${ref}) has no default route; its only condition${conditions.length > 1 ? "s are" : " is"} ${conditions.map((c) => `\`${quote(c)}\``).join(" / ")}.` +
          ` When ${conditions.length > 1 ? "none holds" : "it is false"}, nothing inside the router runs and execution continues at ${next ?? "the end of the enclosing block"}.`,
      );
    }
  }

  /* -- Invokes: responses nobody reads, duplicate names ----------------- */
  const applications = new Map(all(doc, "application").map((a) => [a.getAttribute("name")!, a]));
  const invokes = orchestration ? all(orchestration, "invoke") : [];
  for (const invoke of invokes) {
    const app = applications.get(invoke.getAttribute("refUri") ?? "");
    if (!app) continue;
    const response = all(app, "output").find((o) => text(child(o, "role")) === "response");
    const mc = response && child(response, "messageContextRef")?.getAttribute("refUri");
    if (mc && !readers.get(mc)?.size) {
      fact(
        "invoke-response-unread",
        `The response of invoke ${invoke.getAttribute("id")} "${invoke.getAttribute("name")}" (${text(child(child(app, "adapter")!, "name"))}, ${text(all(app, "operation")[0])}) is not read by any later step.`,
      );
    }
  }
  const names = new Map<string, string[]>();
  for (const invoke of invokes) {
    const name = invoke.getAttribute("name") ?? "";
    names.set(name, [...(names.get(name) ?? []), invoke.getAttribute("id") ?? ""]);
  }
  for (const [name, ids] of names) {
    if (name && ids.length > 1) fact("invoke-name-duplicate", `Invoke name "${name}" is used by ${ids.join(" and ")}.`);
  }

  /* -- catchAll blocks that only log ------------------------------------ */
  for (const tryEl of orchestration ? all(orchestration, "try") : []) {
    const catcher = child(tryEl, "catchAll");
    const steps = catcher ? children(catcher) : [];
    if (steps.length && steps.every((s) => s.localName === "activityStreamLogger")) {
      fact(
        "catch-only-logs",
        `Faults in scope "${tryEl.getAttribute("name")}" are caught by ${catcher!.getAttribute("id")} and only written to the activity stream; execution then continues after the scope as if it had succeeded.`,
      );
    }
  }

  /* -- Transforms that write a literal status --------------------------- */
  for (const s of sources.filter((x) => /\.xslt?$/i.test(x.path))) {
    const proc = /processor_\d+/.exec(s.path)?.[0];
    for (const m of s.text.matchAll(/<(?:[\w.-]+:)?(\w*status\w*)\b[^>]*>\s*<xsl:value-of\b[^>]*select="(?:&quot;|')([^&'"]*)(?:&quot;|')"/gi)) {
      fact("literal-status", `${proc ? step(proc) : s.path} always writes the literal "${m[2]}" to ${m[1]}.`, s.path);
    }
  }

  /* -- Report parameters the data model does not declare ---------------- */
  // BI Publisher echoes each data model parameter into DATA_DS (P_FOO for p_foo),
  // so the read schema is the archive's only record of the names it accepts.
  const echoed = new Set(
    sources
      .filter((s) => /\.(properties|xsd|wsdl)$/i.test(s.path) && s.text.includes("DATA_DS"))
      .flatMap((s) => [...s.text.matchAll(/\bP_[A-Z0-9_]+\b/g)].map((m) => m[0]!)),
  );
  for (const s of sources.filter((x) => /\.xslt?$/i.test(x.path) && x.text.includes("parameterNameValues"))) {
    const sent = [...s.text.matchAll(/<(?:[\w.-]+:)?name\b[^>]*>\s*<xsl:value-of\b[^>]*select="(?:&quot;|')([^&'"]+)(?:&quot;|')"/g)].map((m) => m[1]!);
    const unknown = sent.filter((name) => !echoed.has(name.toUpperCase()));
    if (echoed.size && unknown.length) {
      const proc = /processor_\d+/.exec(s.path)?.[0];
      fact(
        "report-parameter-names",
        `${proc ? step(proc) : s.path} sends report parameters ${sent.join(", ")}, but the report's DATA_DS echoes ${[...echoed].join(", ")}. ` +
          `BI Publisher applies a parameter only when its name matches the data model's, so ${unknown.join(", ")} would not filter the report.`,
        s.path,
      );
    }
  }

  /* -- Connections: literal endpoints, keys, policies ------------------- */
  const prop = (xml: string, name: string) =>
    new RegExp(`<property\\s+name="${name}"\\s+value="([^"]*)"`).exec(xml)?.[1];
  const instanceProp = (xml: string, name: string) =>
    new RegExp(`<name>${name}</name>\\s*<value>([^<]*)</value>`).exec(xml)?.[1];
  const jcas = sources.filter((s) => /\.jca$/i.test(s.path));
  const instances = sources.filter((s) => /(?:^|\/)appinstances\/[^/]+\.xml$/i.test(s.path));
  for (const jca of jcas) {
    const endpoint = prop(jca.text, "endpointURL");
    if (endpoint && /^https?:\/\//i.test(endpoint)) {
      const parameterised = [...jca.text.matchAll(/<property\s+name="(\w+)"\s+value="%%[^"]*"/g)].map((m) => m[1]);
      fact(
        "endpoint-literal",
        `endpointURL is the literal ${quote(endpoint)}, not a connection property${parameterised.length ? ` (while ${parameterised.join(", ")} ${parameterised.length > 1 ? "use" : "uses"} a %%…%% property)` : ""}. Importing this archive elsewhere keeps calling that host until the value is changed.`,
        jca.path,
      );
    }
    // The connection this invoke uses: named in the JCA, or the only one with a credential.
    const keyed = instances.filter((i) => instanceProp(i.text, "csfkey"));
    const inst = instances.find((i) => {
      const code = /<instanceCode>([^<]*)</.exec(i.text)?.[1];
      return code && jca.text.includes(code);
    }) ?? (keyed.length === 1 && prop(jca.text, "csfkey") ? keyed[0] : undefined);
    if (!inst) continue;
    const code = /<instanceCode>([^<]*)</.exec(inst.text)?.[1] ?? inst.path;
    const file = jca.path.split("/").pop();
    const key = prop(jca.text, "csfkey");
    const instanceKey = instanceProp(inst.text, "csfkey");
    if (key && instanceKey && key !== instanceKey) {
      fact(
        "csfkey-mismatch",
        `csfkey differs between ${file} (${key.slice(0, 8)}…) and connection ${code} (${instanceKey.slice(0, 8)}…). A csfkey is a credential-store reference, not a secret.`,
        jca.path,
      );
    }
    const security = prop(jca.text, "security");
    const policy = /<securityPolicy>([^<]*)</.exec(inst.text)?.[1];
    if (security && policy && security !== policy) {
      fact("security-policy", `Connection ${code} declares securityPolicy ${policy}; the invoke in ${file} uses ${security}${managed(jca.text)}.`, jca.path);
    }
  }

  /* -- DVMs: keys no transform looks up, values that look environment-bound */
  const xsl = sources.filter((s) => /\.xslt?$/i.test(s.path)).map((s) => s.text).join("\n");
  for (const dvm of sources.filter((s) => /\.dvm$/i.test(s.path))) {
    const rows = [...dvm.text.matchAll(/<row>\s*<cell>([^<]*)<\/cell>\s*<cell>([^<]*)<\/cell>/g)].map((m) => [m[1]!, m[2]!] as const);
    const name = /<dvm\s+name="([^"]+)"/.exec(dvm.text)?.[1] ?? dvm.path;
    const unused = rows.filter(([key]) => !xsl.includes(`"${key}"`) && !xsl.includes(`'${key}'`) && !xsl.includes(`&quot;${key}&quot;`));
    if (rows.length) {
      fact(
        "dvm-contents",
        `DVM ${name} ships in this archive with ${rows.map(([k, v]) => `${k}=${quote(v, 40)}`).join(", ")}; importing it can overwrite the target environment's copy.` +
          (unused.length ? ` Not looked up by any transform here: ${unused.map(([k]) => k).join(", ")}.` : ""),
        dvm.path,
      );
    }
  }

  return facts;
}

const managed = (jca: string) => (/name="managedSecurity"\s+value="true"/.test(jca) ? " with managedSecurity=true" : "");
