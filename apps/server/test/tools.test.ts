import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { INSTALL_GUIDES, installGuide } from "../src/mcp/guides.js";
import { connectorAvailable, evaluatePreflight, preflightText } from "../src/mcp/preflight.js";
import { a11yCheck, budgetSplit, contrastCheck, normalizeFiles } from "../src/runtime/tool-fns.js";

// Pure functions of the server tools (no Docker, env or database).

describe("files: accepted formats", () => {
  it("record and list become the same record", () => {
    const rec = normalizeFiles({ files: { "A.tsx": "a", "dir/B.test.tsx": "b" } });
    const list = normalizeFiles({ files: [{ path: "A.tsx", content: "a" }, { path: "dir/B.test.tsx", content: "b" }] });
    assert.deepEqual(list, rec);
    assert.deepEqual(rec, { "A.tsx": "a", "dir/B.test.tsx": "b" });
  });

  it("rejects .., absolute and duplicate paths", () => {
    assert.throws(() => normalizeFiles({ files: [{ path: "../x.tsx", content: "" }] }), /\.\./);
    assert.throws(() => normalizeFiles({ files: { "a/../../x.tsx": "" } }), /\.\./);
    assert.throws(() => normalizeFiles({ files: [{ path: "/etc/passwd", content: "" }] }), /absolute/);
    assert.throws(() => normalizeFiles({ files: [{ path: "C:\\x.tsx", content: "" }] }), /absolute/);
    assert.throws(() => normalizeFiles({ files: [{ path: "A.tsx", content: "" }, { path: "A.tsx", content: "" }] }), /duplicate/);
    assert.throws(() => normalizeFiles({ files: "A.tsx" }));
  });
  it("limits count and total size in the object form too", () => {
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`F${i}.tsx`, "x"]));
    assert.throws(() => normalizeFiles({ files: many }), /40 files/);
    assert.throws(() => normalizeFiles({ files: { "A.tsx": "x".repeat(300_001) } }), /300 KB/);
    assert.throws(() => normalizeFiles({ files: [{ path: "A.tsx", content: "x".repeat(200_000) }, { path: "B.tsx", content: "x".repeat(200_000) }] }), /300 KB/);
    assert.equal(Object.keys(normalizeFiles({ files: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`F${i}.tsx`, "x"])) })).length, 40);
  });
});

const rules = (src: string, file = "C.tsx") => {
  const r = a11yCheck({ [file]: src });
  return { passed: r.passed, errors: r.issues.map((i) => i.rule), warnings: r.warnings.map((i) => i.rule) };
};

describe("a11y_check", () => {
  it("a label wrapping the input counts as its label", () => {
    assert.deepEqual(rules(`<label>E-mail <input type="email" name="email" /></label>`).errors, []);
  });

  it("onChange with => before the id does not cut the tag; htmlFor associates", () => {
    const src = `<>
      <label htmlFor="email">E-mail</label>
      <input onChange={(e) => setEmail(e.target.value)} value={email} id="email" />
    </>`;
    assert.deepEqual(rules(src).errors, []);
  });

  it("an input without a label is an error", () => {
    assert.deepEqual(rules(`<input onChange={(e) => set(e.target.value)} id="x" />`).errors, ["label"]);
  });

  it("a button with only an svg is an error; aria-hidden on the svg gives no name", () => {
    assert.deepEqual(rules(`<button onClick={() => del()}><svg viewBox="0 0 24 24"><path d="M0 0" /></svg></button>`).errors, ["button-name"]);
    assert.deepEqual(rules(`<button><svg aria-hidden="true" /></button>`).errors, ["button-name"]);
    assert.deepEqual(rules(`<button type="button"><TrashIcon /></button>`).errors, ["button-name"]);
  });

  it("a button with text or aria-label passes", () => {
    assert.deepEqual(rules(`<button aria-label="Excluir"><svg aria-hidden="true" /></button>`).errors, []);
    assert.deepEqual(rules(`<button><svg aria-hidden="true" /> Excluir</button>`).errors, []);
    assert.deepEqual(rules(`<button>{t("excluir")}</button>`).errors, []);
    assert.deepEqual(rules(`<button><TrashIcon aria-hidden /><span className="sr-only">Excluir</span></button>`).errors, []);
  });

  it("a clickable div without role is an error; with role and tabIndex it passes", () => {
    assert.deepEqual(rules(`<div onClick={() => (a > b ? go() : null)} className="card">x</div>`).errors, ["interactive-div"]);
    assert.deepEqual(rules(`<div role="button" tabIndex={0} onClick={() => go()} onKeyDown={(e) => e.key === "Enter" && go()}>x</div>`).errors, []);
  });

  it("img without alt is an error even with => in an attribute", () => {
    assert.deepEqual(rules(`<img onError={(e) => hide(e)} src={src} />`).errors, ["img-alt"]);
    assert.deepEqual(rules(`<img onError={(e) => hide(e)} src={src} alt="" />`).errors, []);
  });

  it("a positive tabIndex is an error; roving tabindex passes", () => {
    assert.deepEqual(rules(`<div tabIndex={2}>x</div>`).errors, ["tabindex"]);
    assert.deepEqual(rules(`<button role="tab" tabIndex={active ? 0 : -1}>A</button>`).errors, []);
  });

  it("outline:none is a warning with :focus-visible in the file and an error without it", () => {
    const withFv = rules(`.btn { outline: none; }\n.btn:focus-visible { outline: 2px solid; }`, "b.css");
    assert.equal(withFv.passed, true);
    assert.deepEqual(withFv.warnings, ["focus-visible"]);
    const without = rules(`.btn { outline: none; }`, "b.css");
    assert.equal(without.passed, false);
    assert.deepEqual(without.errors, ["focus-visible"]);
  });
});

describe("a11y_check: hostile inputs finish fast (linear)", () => {
  const KB200 = 200_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(KB200 / unit.length));
  const cases: [string, string][] = [
    ["repeated <img a", fill("<img a ")],
    ["repeated <button>", fill("<button>")],
    ["repeated <label>", fill("<label>")],
    ["nested <button><div> without </button>", fill("<button><div>")],
    ["unclosed <button><svg> inside a button", `<button>${fill("<svg>")}</button>`],
    ["nested closed buttons", `${"<button>".repeat(10_000)}x${"</button>".repeat(10_000)}`],
    ["htmlFor with 200 thousand spaces", `<label htmlFor={a${" ".repeat(KB200)}b}>x</label><input id="z" />`],
    ["nested template literals (20 KB+)", `<div title={${"`${".repeat(10_000)}x${"}`".repeat(10_000)}} />`],
    ["outline with spaces", fill("outline      ")],
    ["< without a tag name", fill("a < b ")],
  ];
  for (const [name, src] of cases) {
    it(`${name} (${Math.round(src.length / 1000)} KB) < 500 ms`, () => {
      const t0 = performance.now();
      const r = a11yCheck({ "X.tsx": src });
      const ms = performance.now() - t0;
      assert.ok(typeof r.passed === "boolean");
      assert.ok(ms < 500, `${name}: ${ms.toFixed(0)} ms`);
    });
  }

  it("a nested template literal does not break the check and the next tag is read", () => {
    const src = `<div title={${"`${".repeat(20_000)}x${"}`".repeat(20_000)}} /><img src="a.png" />`;
    assert.deepEqual(rules(src).errors, ["img-alt"]);
  });

  it("htmlFor with spaces and an expression associates with the matching id", () => {
    assert.deepEqual(rules(`<label htmlFor={  emailId  }>E-mail</label><input id={emailId} />`).errors, []);
  });
});

describe("a11y_check: outline", () => {
  it("outline: 0.5px and outline: 0 auto are not a removal", () => {
    assert.deepEqual(rules(`.a { outline: 0.5px solid red; }
.b { outline: 0 auto; }
.c { outline: none-ish; }`, "a.css").errors, []);
  });
  it("outline: 0; none !important and style={{ outline: 'none' }} are a removal", () => {
    assert.deepEqual(rules(`.a { outline: 0; }
.b { outline: none !important }
.c{outline:0}`, "a.css").errors, ["focus-visible", "focus-visible", "focus-visible"]);
    assert.deepEqual(rules(`<button style={{ outline: 'none' }}>Ok</button>`).errors, ["focus-visible"]);
    assert.deepEqual(rules(`<button style={{ outline: 0, color: "red" }}>Ok</button>`).errors, ["focus-visible"]);
  });
});

describe("contrast_check", () => {
  it("border #8C8C8C on #FFFFFF passes as ui (3.36)", () => {
    const [r] = contrastCheck({ pairs: [{ fg: "#8C8C8C", bg: "#FFFFFF", kind: "ui", use: "borda do campo" }] }) as any[];
    assert.equal(r.ratio, 3.36);
    assert.equal(r.pass, true);
    assert.equal(r.use, "borda do campo");
    assert.equal(r.aa.texto, false);
    assert.equal(r.aa.ui, true);
  });

  it("#9CA3AF on #FFF as text fails (2.54)", () => {
    const [r] = contrastCheck({ pairs: [{ fg: "#9CA3AF", bg: "#FFF" }] }) as any[];
    assert.equal(r.ratio, 2.54);
    assert.equal(r.kind, "texto");
    assert.equal(r.pass, false);
  });

  it("large becomes texto-grande; rgb/rgba and #RRGGBBAA formats", () => {
    const [a, b, c] = contrastCheck({
      pairs: [
        { fg: "rgb(0, 0, 0)", bg: "#fff", large: true },
        { fg: "rgba(0, 0, 0, 0.5)", bg: "#FFFFFF" },
        { fg: "#00000080", bg: "rgb(255 255 255)" },
      ],
    }) as any[];
    assert.equal(a.kind, "texto-grande");
    assert.equal(a.ratio, 21);
    // 50% black on white = gray 127.5 (~3.98), below 4.5
    assert.equal(b.fgComposited, "#808080");
    assert.equal(b.ratio, 3.98);
    assert.equal(b.pass, false);
    // #00000080 = alpha 128/255
    assert.ok(Math.abs(c.ratio - b.ratio) < 0.05);
  });

  it("large: true equals kind texto-grande; an explicit kind wins", () => {
    const [viaLarge, viaKind, both] = contrastCheck({
      pairs: [
        { fg: "#767676", bg: "#FFFFFF", large: true },
        { fg: "#767676", bg: "#FFFFFF", kind: "texto-grande" },
        { fg: "#8C8C8C", bg: "#FFFFFF", large: true, kind: "texto" },
      ],
    }) as any[];
    const { use: _u1, ...a } = viaLarge;
    const { use: _u2, ...b } = viaKind;
    assert.deepEqual(a, b);
    assert.equal(viaLarge.kind, "texto-grande");
    assert.equal(viaLarge.pass, true);
    assert.equal(both.kind, "texto");
    assert.equal(both.pass, false);
  });

  it("a bg with alpha errors only on that pair", () => {
    const out = contrastCheck({
      pairs: [
        { fg: "#000", bg: "rgba(255,255,255,0.5)" },
        { fg: "#000", bg: "#fff" },
        { fg: "azul", bg: "#fff" },
      ],
    }) as any[];
    assert.match(out[0].error, /transparency/);
    assert.equal(out[1].ratio, 21);
    assert.match(out[2].error, /Invalid color/);
  });
});

describe("budget_split", () => {
  const sum = (c: Record<string, number>) => Math.round(Object.values(c).reduce((a, b) => a + b, 0) * 100) / 100;

  it("the sum matches the total in cents", () => {
    for (const total of [45000, 1234.57, 999.99, 7]) {
      const r = budgetSplit({ total, days: 7, travelers: 3, profile: "conforto" });
      assert.equal(sum(r.categories), total);
    }
  });

  it("minimum 10% reserve with an alert", () => {
    const r = budgetSplit({ total: 10000, days: 5, profile: "economico", emergencyReservePct: 5 });
    assert.equal(r.categories.reserva, 1000);
    assert.equal(r.emergencyReservePct, 10);
    assert.ok(r.alerts.some((a) => /Emergency reserve raised/.test(a)));
    const padrao = budgetSplit({ total: 10000, days: 5 });
    assert.equal(padrao.categories.reserva, 1000);
  });

  it("accepts luxo and the old style key", () => {
    assert.equal(budgetSplit({ total: 80000, days: 10, profile: "luxo" }).profile, "luxo");
    const old = budgetSplit({ total: 8000, days: 10, style: "economico" });
    assert.equal(old.profile, "economico");
    assert.equal(old.destinationType, "internacional");
    assert.equal(old.currency, "BRL");
  });

  it("nacional has no insurance", () => {
    const r = budgetSplit({ total: 6000, days: 4, travelers: 2, destinationType: "nacional", profile: "moderado" });
    assert.equal(r.categories.seguro, 0);
    assert.equal(sum(r.categories), 6000);
  });

  it("alreadyPaid stays fixed in the category and alerts when above the suggestion", () => {
    const r = budgetSplit({ total: 45000, days: 15, travelers: 3, profile: "conforto", alreadyPaid: { aereo: 20000, hospedagem: 0 } });
    assert.equal(r.categories.aereo, 20000);
    assert.equal(r.categories.reserva, 4500);
    assert.equal(sum(r.categories), 45000);
    assert.ok(r.alerts.some((a) => /flights: already paid/.test(a)));
  });

  it("a low local daily spend raises an alert; perPersonPerDayLocal = (food+tours+transport)/days/people", () => {
    const r = budgetSplit({ total: 5000, days: 10, travelers: 2, profile: "economico" });
    const c = r.categories;
    assert.equal(r.perPersonPerDayLocal, Math.round(((c.alimentacao + c.passeios + c.transporteLocal) * 100) / 20) / 100);
    assert.ok(r.alerts.some((a) => /daily spend at the destination/.test(a)));
  });

  it("comparisons in cents: a total that rounds to 0 cents is rejected; alreadyPaid equal to the total in cents passes", () => {
    assert.throws(() => budgetSplit({ total: 0.004, days: 1 }), /0\.01/);
    const r = budgetSplit({ total: 100.004, days: 1, alreadyPaid: { aereo: 100.001 } });
    assert.equal(sum(r.categories), 100);
    assert.equal(r.categories.aereo, 100);
    assert.throws(() => budgetSplit({ total: 100, days: 1, alreadyPaid: { aereo: 50.005, hospedagem: 50 } }), /alreadyPaid/);
  });

  it("exact sum with fractional amounts and alreadyPaid", () => {
    for (const total of [0.01, 0.07, 1.01, 333.33, 98765.43]) {
      for (const destinationType of ["nacional", "internacional"] as const) {
        const r = budgetSplit({ total, days: 3, travelers: 2, destinationType, alreadyPaid: { hospedagem: total / 3 } });
        assert.equal(sum(r.categories), total, `${total} ${destinationType}`);
        for (const v of Object.values(r.categories)) assert.ok(v >= 0);
      }
    }
  });

  it("nacional with everything paid except insurance: the alert does not say everything is paid", () => {
    const r = budgetSplit({
      total: 10000,
      days: 5,
      destinationType: "nacional",
      alreadyPaid: { aereo: 2000, hospedagem: 3000, alimentacao: 1500, passeios: 1000, transporteLocal: 500 },
    });
    assert.equal(sum(r.categories), 10000);
    assert.equal(r.categories.seguro, 0);
    assert.equal(r.categories.reserva, 2000);
    const alert = r.alerts.find((a) => /leftover/.test(a))!;
    assert.match(alert, /insurance/);
    assert.doesNotMatch(alert, /All categories are already paid/);
    const all = budgetSplit({
      total: 10000,
      days: 5,
      alreadyPaid: { aereo: 2000, hospedagem: 3000, alimentacao: 1500, passeios: 1000, transporteLocal: 500, seguro: 100 },
    });
    assert.ok(all.alerts.some((a) => /All categories are already paid/.test(a)));
  });

  it("alreadyPaid above the total is rejected", () => {
    assert.throws(() => budgetSplit({ total: 1000, days: 2, alreadyPaid: { aereo: 1500 } }));
  });
});

describe("preflight_check", () => {
  const figma = { type: "connector" as const, label: "Figma", key: "figma" };

  it("accepts Figma tools without 'figma' in the name, with or without a prefix", () => {
    for (const t of ["get_design_context", "mcp__remote__get_variable_defs", "Server:get_metadata", "get_screenshot"]) {
      assert.equal(evaluatePreflight([figma], [t]).blocked, false, t);
    }
    assert.equal(evaluatePreflight([figma], ["figma_whoami"]).blocked, false);
    assert.equal(evaluatePreflight([figma], ["get_design_context_extra", "search_web"]).blocked, true);
  });

  it("a missing required connector blocks", () => {
    const r = evaluatePreflight([figma], ["search_web"]);
    assert.equal(r.blocked, true);
    assert.match(preflightText([figma], [], "s1"), /Do not move on to next_step/);
  });

  it("a missing optional connector only warns and allows next_step", () => {
    const req = [{ ...figma, optional: true }, { type: "client" as const, label: "Claude ou ChatGPT", key: "any" }];
    const r = evaluatePreflight(req, ["search_web"]);
    assert.equal(r.blocked, false);
    assert.equal(r.warnings.length, 1);
    const text = preflightText(req, ["search_web"], "s1");
    assert.match(text, /Figma not connected: follow the no-connector path in step 1/);
    assert.match(text, /call next_step with session_id="s1"/);
    assert.doesNotMatch(text, /Do not move on/);
  });

  it("a key with a space matches tool names with underscores", () => {
    const drive = { type: "connector" as const, label: "Google Drive", key: "Google Drive" };
    for (const t of ["mcp__claude_ai_Google_Drive__authenticate", "google_drive_search"]) {
      assert.equal(evaluatePreflight([drive], [t]).blocked, false, t);
    }
    assert.equal(connectorAvailable("google drive", ["mcp__claude_ai_Google_Drive__authenticate"]), true);
    assert.equal(connectorAvailable("Google Drive", ["mcp__claude_ai_Google_Calendar__authenticate"]), false);
  });

  it("a key with an accent and a catalog alias", () => {
    assert.equal(connectorAvailable("Agenda Pública", ["agenda_publica_list"]), true);
    assert.equal(connectorAvailable("Google Agenda", ["mcp__claude_ai_Google_Calendar__authenticate"]), true);
    assert.equal(connectorAvailable("Google Planilhas", ["google_sheets_read"]), true);
    assert.equal(connectorAvailable("", ["qualquer"]), false);
  });

  it("missing required blocks and includes the guide; missing optional warns with the guide", () => {
    const drive = { type: "connector" as const, label: "Google Drive", key: "google_drive" };
    const r = evaluatePreflight([drive], ["search_web"]);
    assert.equal(r.blocked, true);
    assert.match(r.missing[0], /How to connect Google Drive/);
    assert.match(r.missing[0], /Claude:.*ChatGPT:/s);
    const o = evaluatePreflight([{ ...drive, optional: true }], ["search_web"]);
    assert.equal(o.blocked, false);
    assert.match(o.warnings[0], /Google Drive not connected.*How to connect Google Drive/s);
  });

  it("the creator's howTo wins over the catalog and includes the official help", () => {
    const req = { type: "connector" as const, label: "Notion", key: "notion", howTo: "Ative o Notion e escolha a página do projeto.", helpUrl: "https://ajuda.exemplo.com/notion" };
    const g = installGuide(req);
    assert.match(g, /^Ative o Notion e escolha a página do projeto\./);
    assert.match(g, /Official help: https:\/\/ajuda\.exemplo\.com\/notion/);
    assert.doesNotMatch(g, /How to connect/);
    assert.match(evaluatePreflight([req], []).missing[0], /Ative o Notion/);
  });

  it("catalog with helpUrl and a non-catalog connector without howTo use the generic text", () => {
    assert.match(installGuide({ label: "Slack", key: "slack", helpUrl: "https://ajuda.exemplo.com/slack" }), /How to connect Slack[\s\S]*Official help: https:\/\/ajuda\.exemplo\.com\/slack/);
    assert.equal(installGuide({ label: "Trello" }), "Ask the user to add the Trello connector in their AI assistant's settings.");
    assert.match(installGuide({ label: "Trello", helpUrl: "https://ajuda.exemplo.com/t" }), /settings\.\nOfficial help: https:\/\/ajuda\.exemplo\.com\/t$/);
  });

  it("catalog guides exist for the wizard connectors", () => {
    for (const k of ["figma", "github", "google_drive", "google_agenda", "google_planilhas", "gmail", "notion", "slack"]) {
      assert.ok(INSTALL_GUIDES[k], k);
      assert.equal(installGuide({ label: k, key: k }), INSTALL_GUIDES[k]);
    }
  });
});
