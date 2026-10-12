// "Connect your wallet to Solvers" page, served by this server at /oauth/authorize/extension (the web app's /connect is
// the main path). Self-contained (no build): discovers injected EVM wallets with EIP-6963 (falling back to
// window.ethereum), signs the SIWE message (EIP-4361) built by the server for this page's host, then the memory-key
// message (EIP-191 personal_sign). English by default; Portuguese (pt-BR) when the browser asks (Accept-Language) or ?lang=pt.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type PageLang = "en" | "pt";

/** Page language: ?lang=pt|en wins; else the first Accept-Language entry; English by default. */
export function pageLang(query?: unknown, acceptLanguage?: string): PageLang {
  if (query === "pt" || query === "en") return query;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("pt") ? "pt" : "en";
}

const TEXT = {
  en: {
    htmlLang: "en",
    title: "Connect to Solvers",
    cannotContinue: "We couldn't continue",
    connectTitle: (name: string) => `Connect ${name} to Solvers`,
    defaultClient: "your assistant",
    intro: "This way your specialists work right inside the chat.",
    verifiedDest: (host: string) => `Verified destination: <strong>${host}</strong>`,
    unverifiedDest: (host: string) => `⚠ Unverified app. Access will be sent to <strong>${host}</strong>. Continue only if you started this connection yourself.`,
    bullet1: "You confirm the wallet is yours (free, no payment).",
    bullet2: "A second signature protects your memories with encryption.",
    button: "Connect wallet",
    fine: (link: string) => `No wallet? Sign in through the ${link} with your email and come back here.`,
    fineLink: "Solvers store",
    js: {
      noWallet: "No wallet found in this browser. Install a browser wallet (e.g. MetaMask or Rabby) or use the store with your email.",
      choose: "Choose your wallet:",
      opening: "Opening your wallet…",
      startFail: "Couldn't start",
      confirmLogin: "Confirm the login signature in your wallet…",
      memorySig: "Now the signature that protects your memories…",
      connecting: "Connecting…",
      connectFail: "Couldn't connect",
      done: "Done! Taking you back to your assistant…",
      generic: "Something went wrong. Please try again.",
    },
  },
  pt: {
    htmlLang: "pt-BR",
    title: "Conectar ao Solvers",
    cannotContinue: "Não foi possível continuar",
    connectTitle: (name: string) => `Conectar ${name} ao Solvers`,
    defaultClient: "seu assistente",
    intro: "Assim seus especialistas passam a funcionar dentro do chat.",
    verifiedDest: (host: string) => `Destino verificado: <strong>${host}</strong>`,
    unverifiedDest: (host: string) => `⚠ Aplicativo não verificado. O acesso será enviado para <strong>${host}</strong>. Continue só se você mesmo iniciou esta conexão.`,
    bullet1: "Você confirma que a carteira é sua (sem custo e sem pagamento).",
    bullet2: "Uma segunda assinatura protege suas memórias com criptografia.",
    button: "Conectar carteira",
    fine: (link: string) => `Não tem carteira? Entre pela ${link} com seu e-mail e volte aqui.`,
    fineLink: "loja do Solvers",
    js: {
      noWallet: "Nenhuma carteira encontrada neste navegador. Instale uma carteira de navegador (ex.: MetaMask ou Rabby) ou use a loja com e-mail.",
      choose: "Escolha sua carteira:",
      opening: "Abrindo a carteira…",
      startFail: "Falha ao iniciar",
      confirmLogin: "Confirme a assinatura de login na carteira…",
      memorySig: "Agora a assinatura que protege suas memórias…",
      connecting: "Conectando…",
      connectFail: "Falha ao conectar",
      done: "Pronto! Voltando para o seu assistente…",
      generic: "Algo deu errado. Tente de novo.",
    },
  },
} as const;

export function authorizePage(p: {
  requestId?: string;
  clientName?: string;
  redirectHost?: string;
  verified?: boolean;
  apiBase?: string;
  webUrl?: string;
  memoryMessage?: string;
  error?: string;
  lang?: PageLang;
}) {
  const t = TEXT[p.lang ?? "en"];
  const config = JSON.stringify({ req: p.requestId, api: p.apiBase, memoryMessage: p.memoryMessage, t: t.js }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1b1b1f; --muted:#5b5b66; --line:#e6e6e0; --accent:#6b4ce6; --accent2:#14b8a6; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111114; --card:#1a1a1f; --ink:#f2f2f5; --muted:#a3a3ad; --line:#2a2a31; --err:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; }
  .card { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; margin-bottom:18px; }
  .dot { width:22px; height:22px; border-radius:7px; background:linear-gradient(135deg,var(--accent),var(--accent2)); }
  h1 { font-size:22px; margin:0 0 8px; }
  p { color:var(--muted); margin:0 0 16px; }
  ul { color:var(--muted); padding-left:20px; margin:0 0 20px; }
  button { width:100%; border:0; border-radius:10px; padding:13px 16px; font-size:16px; font-weight:600; cursor:pointer;
           background:var(--ink); color:var(--card); }
  button:disabled { opacity:.55; cursor:default; }
  button:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  .status { margin-top:14px; font-size:14px; color:var(--muted); min-height:20px; }
  .error { color:var(--err); }
  .fine { font-size:13px; margin-top:18px; }
  .wallets { display:grid; gap:8px; margin-top:12px; }
  .wallets button { display:flex; align-items:center; gap:10px; background:var(--card); color:var(--ink); border:1px solid var(--line); }
  .wallets img { width:24px; height:24px; border-radius:6px; }
  .dest { font-size:14px; border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin:0 0 16px; }
  .warn { border-color:#f79009; color:var(--ink); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="dot" aria-hidden="true"></span>Solvers</div>
  ${
    p.error
      ? `<h1>${t.cannotContinue}</h1><p class="error">${esc(p.error)}</p>`
      : `<h1>${t.connectTitle(esc(p.clientName ?? t.defaultClient))}</h1>
  <p>${t.intro}</p>
  <p class="dest${p.verified ? "" : " warn"}">${p.verified ? t.verifiedDest(esc(p.redirectHost ?? "")) : t.unverifiedDest(esc(p.redirectHost ?? ""))}</p>
  <ul>
    <li>${t.bullet1}</li>
    <li>${t.bullet2}</li>
  </ul>
  <button id="go" type="button">${t.button}</button>
  <div id="wallets" class="wallets" hidden></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <p class="fine">${t.fine(`<a href="${esc(p.webUrl ?? "/")}" target="_blank" rel="noopener">${t.fineLink}</a>`)}</p>`
  }
</main>
${
  p.error
    ? ""
    : `<script>
const CFG = ${config};
const $ = (id) => document.getElementById(id);
const say = (t, err) => { const s = $("status"); s.textContent = t; s.className = "status" + (err ? " error" : ""); };
// EIP-6963: wallets announce themselves in response to "eip6963:requestProvider".
const found = new Map();
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d && d.info && d.provider && typeof d.info.uuid === "string") found.set(d.info.uuid, d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
function providers() {
  const list = [...found.values()];
  if (list.length === 0 && window.ethereum) list.push({ info: { uuid: "injected", name: "Browser wallet", icon: "" }, provider: window.ethereum });
  return list;
}
function utf8Hex(text) {
  return "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sign(p, address, text) {
  return p.request({ method: "personal_sign", params: [utf8Hex(text), address] });
}
async function connectWith(p) {
  $("go").disabled = true;
  $("wallets").hidden = true;
  try {
    say(CFG.t.opening);
    const accounts = await p.request({ method: "eth_requestAccounts" });
    const address = String((accounts && accounts[0]) || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(CFG.t.startFail);
    const q = new URLSearchParams({ req: CFG.req, address, domain: location.host, uri: location.origin });
    const n = await fetch(CFG.api + "/oauth/authorize/nonce?" + q).then((r) => r.json());
    if (!n.message) throw new Error(n.error || CFG.t.startFail);
    say(CFG.t.confirmLogin);
    const signature = await sign(p, address, n.message);
    say(CFG.t.memorySig);
    const memorySignature = await sign(p, address, CFG.memoryMessage);
    say(CFG.t.connecting);
    const done = await fetch(CFG.api + "/oauth/authorize/complete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ req: CFG.req, wallet: address, message: n.message, signature, memorySignature }),
    }).then((r) => r.json());
    if (!done.redirectTo) throw new Error(done.error_description || done.error || CFG.t.connectFail);
    say(CFG.t.done);
    location.href = done.redirectTo;
  } catch (e) {
    say((e && (e.shortMessage || e.message)) || CFG.t.generic, true);
    $("go").disabled = false;
  }
}
$("go").addEventListener("click", () => {
  const list = providers();
  if (list.length === 0) { say(CFG.t.noWallet, true); return; }
  if (list.length === 1) { connectWith(list[0].provider); return; }
  const box = $("wallets");
  box.textContent = "";
  const label = document.createElement("p");
  label.textContent = CFG.t.choose;
  box.appendChild(label);
  for (const d of list) {
    const b = document.createElement("button");
    b.type = "button";
    if (typeof d.info.icon === "string" && d.info.icon.startsWith("data:image/")) {
      const img = document.createElement("img");
      img.src = d.info.icon;
      img.alt = "";
      b.appendChild(img);
    }
    b.appendChild(document.createTextNode(String(d.info.name || "Wallet")));
    b.addEventListener("click", () => connectWith(d.provider));
    box.appendChild(b);
  }
  box.hidden = false;
});
</script>`
}
</body>
</html>`;
}
