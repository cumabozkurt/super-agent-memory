// Write-time guard against memory poisoning / laundering (roadmap P0-6, redteam X6/X7).
//
// Every non-user write (agent markers, mem_save, auto-captured fixes, team files, imports) is classified BEFORE it
// is stored. Three outcomes, kept in memories.status:
//   active       normal row
//   quarantined  matched injection heuristics: hidden from cards, recall, file notes and MCP; visible only to `sam review`
//   pending      over the per-session/day cap for agent writes, or an agent-written rule while `reviewAgentRules` is on
//
// Design rule (X6): a plain command is NOT a signal. `procedure`/`fix` rows are full of shell commands, and the
// classifier must leave them alone. Quarantine needs a high-risk pattern (pipe-to-shell, exfiltration, "ignore previous",
// concealment from the user, tool-call/role imitation, hidden unicode, instructions addressed to an AI, hidden
// comments with instructions) or two medium ones (e.g. "disable tests" + a standing "always").
// Nothing here calls a model: it is a handful of bounded regexes over ≤ 8 KB of text.
import { config } from './config.js';
import { localDay, openDb as openDbLazy } from './db.js';

export const GUARDED_SOURCES = new Set(['agent', 'auto', 'team', 'import']);
export const RULE_KINDS = new Set(['convention', 'preference', 'procedure']);
// Cards render these INSTEAD of the plain "- " bullet on non-user lines (user and auto-observed lines keep "- ").
// "-a"/"-t"/"-i" are each ONE o200k token, exactly like "-" (measured with tiktoken), so a tagged line costs nothing
// extra; "~a" would cost +1 token per line. The only overhead is the one-line legend, added when a tagged line is shown.
export const SOURCE_TAG = { agent: '-a', team: '-t', import: '-i' };
export const QUARANTINE_AT = 3; // score threshold; a "high" rule scores 3 on its own
// signals that only amplify: alone (or together) they never quarantine
const CONTEXT = new Set(['standing-order', 'privilege', 'remote-fetch', 'permissive']);
// unsafe-advice rules: a prohibition in front of them inverts their meaning ("never log API keys" is good practice)
const NEGATED = /\b(?:never|no|not|don'?t|do not|avoid|without|forbidden|prohibited|asla|hiçbir|yasak|olmadan)\b[^.;,\n]*$/iu;
const ADVICE = new Set(['secret-exposure', 'auth-bypass', 'unsafe-git', 'data-loss', 'skip-checks', 'untrusted-code', 'disable-safety', 'secret-path', 'destructive']);

// ---- hidden characters: checked on the RAW text (sanitize() strips them before storage, so the signal is lost later)
// tag characters (U+E0000 block), bidi overrides/isolates: never legitimate in a memory line
const HIDDEN_HARD = /\uDB40[\uDC00-\uDC7F]|[\u202A-\u202E\u2066-\u2069]/;
// zero-width space / non-joiner / word joiner / BOM / soft hyphen; ZWJ (U+200D) and VS16 are emoji glue, not counted
const ZW = /[\u200B\u200C\u2060\uFEFF\u00AD\u180E]/g;

const NET = String.raw`(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|nc|ncat|netcat|scp|rsync|ftp|httpie|http\s+(?:post|get))`;
const SECRET = String.raw`(?:secrets?|credentials?|creds|tokens?|api[ _-]?keys?|passwords?|passwd|private[ _-]?keys?|ssh[ _-]?keys?|id_rsa|id_ed25519|\.env\b|env(?:ironment)?\s+var(?:iable)?s?|cookies?|session[ _-]?ids?|aws_secret\w*|\.npmrc|\.netrc|kubeconfig|şifre\w*|parola\w*|anahtar\w*)`;

// [name, weight, regex]. Weight 3 = quarantine alone; 2 = medium; 1 = context.
const RULES = [
  // instruction override / role hijack
  ['override', 3, /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|other|system|your|the)\b[^.\n]{0,25}\b(?:instructions?|rules?|prompts?|guidelines?|directions?|directives?|context|guardrails?|polic(?:y|ies))\b/i],
  ['override', 3, /\b(?:önceki|yukarıdaki|tüm|bütün)\s+(?:talimat|kural|yönerge)\w*\s+(?:yok say|görmezden gel|unut|dikkate alma)\w*/iu],
  ['role-hijack', 3, /\byou\s+are\s+now\b|\bnew\s+(?:system\s+)?instructions?\s*:|\b(?:developer|god|dan|jailbreak)\s+mode\b|\bjailbreak\w*|\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|root|admin\w*|system)\b/i],
  // text written TO an AI reader: the hallmark of indirect injection ("note to AI agents reading this")
  ['addressed-to-ai', 3, /\b(?:note|message|instructions?|reminder|attention)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llms?|assistants?|agents?|models?|claude|codex|gemini|copilot|cursor|chatgpt)\b|\b(?:ai|llm|coding)\s+(?:assistants?|agents?|models?)\s+(?:reading|processing|parsing|seeing)\s+this\b|\bif\s+you\s+are\s+an?\s+(?:ai|llm|language\s+model|assistant|agent|bot)\b|\b(?:dear|hey|hi)\s+(?:ai|assistant|claude|codex|gemini|agent)\b/i],
  // tool-call / chat-template / role imitation
  ['tool-imitation', 3, /<\/?\s*(?:function_calls|invoke|antml:\w+|tool_use|tool_call|tool_result|function_results|parameter\s+name|system|assistant|user_query|im_start|im_end)\b|<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|<<\s*SYS\s*>>|\[\/?INST\]|"(?:tool_use|function_call|tool_calls|tool_name)"\s*:/i],
  ['role-prefix', 3, /(?:^|\n|\.\s+)(?:system|assistant|developer)\s*:\s*(?:you|ignore|from now|always|never|new)\b/i],
  // remote code execution
  ['pipe-to-shell', 3, new RegExp(String.raw`\b${NET}\b[^\n|]{0,200}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b|\b${NET}\b[^\n|]{0,200}\|\s*(?:iex|invoke-expression|python3?|node|perl|ruby|php)\b|\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*${NET}|\b(?:ba|z)?sh\s+<\(\s*${NET}|\b(?:iex|invoke-expression)\b[^\n]{0,40}(?:downloadstring|iwr|irm|invoke-webrequest)`, 'i')],
  ['decode-exec', 3, /\bbase64\s+(?:-d|--decode|-D)\b[^\n]{0,80}\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|buffer\.from)\b|\beval\s+["']?\$\(\s*(?:echo|printf)\b[^\n]{0,200}base64|frombase64string[^\n]{0,80}(?:iex|invoke-expression)/i],
  // exfiltration
  ['exfiltration', 3, /\bexfiltrat\w*/i],
  ['exfiltration', 3, new RegExp(String.raw`\b(?:send|upload|post|forward|transmit|leak|copy|share|email|paste|report)\w*\s+(?:(?:the|all|any|every|your|our|their|its|his|her|these|those|my)\s+)?(?:\w+\s+){0,2}${SECRET}[^\n]{0,60}\b(?:to|at|into)\s+(?:https?:\/\/|[\w-]+\.[a-z]{2,}|(?:a|an|the|this|my|our)?\s*(?:remote|external|webhook|endpoint|server|url|pastebin|gist|discord|slack|telegram))`, 'i')],
  ['exfiltration', 3, new RegExp(String.raw`\b${NET}\b[^\n]{0,160}(?:-d\s*@|--data(?:-binary|-raw)?\s*@|-F\s*\S*=@|-T\s|--upload-file)\s*["']?(?:~|\$HOME|\/etc|\/root|\.env|[^\s"']*(?:\.ssh|\.aws|\.gnupg|id_rsa|credentials|\.npmrc|\.netrc))|\b${NET}\b[^\n]{0,200}\$\{?(?:\w*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE)\w*)\}?`, 'i')],
  // credentials and an external URL / paste target in the same sentence
  ['secret-to-url', 3, new RegExp(String.raw`\b${SECRET}[^.\n]{0,120}\b(?:to|at|into|on)\s+https?:\/\/(?!(?:localhost|127\.0\.0\.1)\b)|${SECRET}[^.\n]{0,120}(?:paste\s*(?:bin|servis\w*|service|site)|pastebin|webhook\.site|requestbin|ngrok)|\b(?:print|dump)env\b[^.\n]{0,80}(?:paste\s*(?:bin|servis\w*|service)|pastebin|https?:\/\/)`, 'iu')],
  // overruling the human ("the note wins over the user", "override the request", "never wait for confirmation")
  ['override-user', 3, /\b(?:override|overrule|ignore|disregard)\s+(?:the\s+)?(?:user'?s?|human'?s?|developer'?s?)?\s*(?:request|instructions?|wishes|confirmation|answer)\b|\bnever\s+(?:wait\s+for|ask\s+for|seek)\s+(?:the\s+)?(?:user|human)?\s*(?:confirmation|approval|permission)\b|\bkullanıcı\w*\s+talimat\w*[^.\n]{0,80}(?:çakış\w*)[^.\n]{0,60}(?:bu\s+not\w*|repo\w*\s+kural\w*)[^.\n]{0,30}(?:izle|uy|geçerli)/iu],
  ['exfiltration', 3, /\b(?:cat|type|printenv|env|set)\b[^\n|]{0,80}\|\s*(?:curl|wget|nc|ncat|netcat|base64\b[^\n]{0,40}\|\s*(?:curl|wget|nc))\b/i],
  // concealment from the human
  ['conceal', 3, /\b(?:do\s+not|don'?t|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|reveal(?:ing)?|show(?:ing)?|alert(?:ing)?|notify(?:ing)?|ask(?:ing)?|let(?:ting)?)\b[^.\n]{0,20}\b(?:the\s+)?(?:user|human|developer|operator|maintainers?|team|reviewer|anyone)\b|\b(?:silently|secretly|covertly|quietly)\s+(?:run|execute|send|upload|install|delete|disable|modify|add|push|commit)\b|\bkullanıcıya\s+(?:söyleme|haber verme|gösterme)/iu],
  // self-replication / laundering into memory
  ['self-replicating', 3, /⟦\s*mem(?:\s+[\p{L}]+)?\s*:\s*(?![\s<]|text⟧)[^⟧]{4,}⟧|\[\[\s*mem(?:\s+[\p{L}]+)?\s*:\s*(?![\s<])[^\]]{4,}\]\]|\b(?:save|store|write|add|persist|record|memori[sz]e)\s+(?:this|the\s+following|these|it)\s+(?:(?:to|in|into)\s+)?(?:(?:your|long[- ]term|persistent|permanent)\s+){0,2}(?:memory|memories|mem_save|notes)\b|\bhafızana\s+(?:kaydet|yaz|ekle)|\bbelleğine\s+(?:kaydet|yaz|ekle)|\bmem_save\s*\(/iu],
  // hidden markup with an instruction in it (a bare <!-- prettier-ignore --> is benign)
  ['hidden-comment', 3, /<!--(?=[^]{0,300}?-->)[^]{0,300}?\b(?:you|your|assistant|agent|ai|llm|model|claude|codex|gemini|execute|run|curl|wget|send|always|must|instructions?|ignore\s+(?:previous|all|the))\b[^]{0,300}?-->|\[\/\/\]:\s*#\s*[("][^)"]{0,200}\b(?:you|assistant|agent|ai|execute|run|curl|always|must|instructions?)\b/i],
  ['hidden-comment', 2, /<!--[^]{0,400}?-->|\[\/\/\]:\s*#\s*[("]/],
  // weakening safety nets (benign fixes say "disabled X because…" without a standing order: needs a 2nd signal)
  ['disable-safety', 2, /\b(?:disable|skip|bypass|turn\s+off|comment\s+out|delete|remove|mute|silence)\w*\s+(?:(?:all|the|any|every|failing|broken|our)\s+)*(?:unit\s+|e2e\s+|integration\s+)?(?:tests?|test\s+suites?|ci|checks?|linters?|lint(?:ing)?|pre-?commit\s+hooks?|git\s+hooks?|hooks?|type-?check\w*|security\s+\w+|signature\s+\w+|ssl\s+\w+|tls\s+\w+|cert\w*\s*\w*|sandbox\w*|approvals?|2fa|mfa|audit\w*|branch\s+protection)\b/i],
  ['disable-safety', 2, /\b(?:tests?|testler\w*|smoke|check\s*step\w*|kontrol\w*|lint\w*|ci|doğrulama\w*|imza\s+kontrol\w*|signature\s+kontrol\w*)[^.\n]{0,60}(?:yorum\s+satırına\s+al\w*|devre\s+dışı\s+bırak\w*|kapat\w*|atla\w*|skip\s+et\w*|bypass\s+et\w*)/iu],
  ['disable-safety', 2, /\b(?:tests?|checks?|ci|lint(?:ers?|ing)?|(?:git\s+|pre-?commit\s+)?hooks?|branch\s+protection|verification|signature\s+checks?|code\s+review|reviews?|approvals?)\s+(?:should|can|may|must|could)\s+(?:just\s+)?be\s+(?:removed|disabled|skipped|bypassed|turned\s+off|commented\s+out|deleted)\b/i],
  ['disable-safety', 2, /--no-verify\b|--insecure\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|\bstrict-ssl\s+false|\bGIT_SSL_NO_VERIFY|\bverify\s*=\s*False\b|\bset\s+-x?\s*\+e\b/i],
  // credential stores / sensitive paths (benign memories rarely need them)
  ['secret-path', 2, /(?:~|\$HOME|%USERPROFILE%)[\\/]\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|git-credentials)\b|\bid_(?:rsa|ed25519|ecdsa)\b(?!\.pub)|\/etc\/(?:shadow|passwd|sudoers)\b|\bprintenv\b|\bsecurity\s+find-generic-password\b/i],
  // supply chain: foreign package registries / index URLs
  ['foreign-registry', 2, /\b(?:npm|pnpm|yarn)\s+config\s+set\s+registry\s+https?:\/\/(?!registry\.(?:npmjs\.org|yarnpkg\.com))|--(?:extra-)?index-url\s+https?:\/\/(?!pypi\.org)|\bnpm\s+i(?:nstall)?\s+(?:-g\s+)?https?:\/\//i],
  // destructive
  ['destructive', 2, /\brm\s+-(?:rf|fr|r\s+-f|f\s+-r)\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~\/?(?:\s|$)|\$HOME\b|\.\.\/\.\.|\*\s*$)|\bgit\s+push\s+(?:-f|--force)\b[^\n]{0,40}\b(?:main|master|prod\w*|release)\b|\bchmod\s+-R\s+777\b|\bmkfs\b|\bdd\s+if=[^\n]{0,40}of=\/dev\/|\bdrop\s+(?:database|schema)\b|\bgit\s+reset\s+--hard\s+origin/i],
  // a URL whose fetch is ordered as a standing rule (only scores together with "always/every")
  ['remote-fetch', 1, new RegExp(String.raw`\b${NET}\b[^\n]{0,80}https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b)`, 'i')],
  ['long-blob', 2, /[A-Za-z0-9+/]{120,}={0,2}/],
  ['privilege', 1, /\bsudo\s+(?!apt(?:-get)?\s+install|dnf\s+install|yum\s+install|brew)\S/i],
  // ---- unsafe advice (medium): poisoned "tips" rarely carry injection syntax; they recommend weakening something.
  // Each scores 2, so it needs a second signal — typically the permissive framing ("acceptable", "temporarily", "-abilir").
  ['secret-exposure', 2, /\b(?:print|log|dump|echo|paste|post|return|expose|write|show|include|collect|export|upload)\w*\s+(?:out\s+)?(?:all\s+|the\s+|any\s+|full\s+)*(?:\w+\s+){0,3}(?:env(?:ironment)?\s+(?:var\w*|values?|output)|secrets?|tokens?|(?:service[ _-]role|api|private|apple\s+api)\s+keys?|credentials|passwords?|auth\s+headers?|session\s+payload)\b|\b(?:secrets?|tokens?|keys|env\s*(?:değer\w*|snapshot)|AUTH_SECRET|DATABASE_URL|\w+_TOKEN|headers?)\b[^.\n]{0,80}(?:issue\w*|log\w*|console\w*|summary|endpoint\w*|response)[^.\n]{0,20}(?:yapıştır\w*|yaz\w*|bas\w*|döndür\w*|dön\w*|açık\s+bırak\w*)|\bmasked\s+olmadan|\bwithout\s+masking\b|\bunmasked\b/iu],
  ['auth-bypass', 2, /\bbypass\w*\s+(?:auth\w*|flag|login|verification)|\bX-Bypass-Auth\b|\bskip\w*\s+(?:\w+\s+){0,2}(?:email\s+)?verification\b|\baccept\s+any\s+(?:session|token|signature|cert\w*)\b|\btrust\s+any\s+(?:stored\s+)?(?:session|token|input)\b|\bdo\s+not\s+revalidate\b|\bauth\s+olmadan\b|\b(?:requireRole|auth\w*|role|prefix|signature|imza|webhook)\s*(?:`\s*)?(?:kontrol\w*|doğrulama\w*)\w*\s+(?:tamamen\s+)?(?:kaldır\w*|kapat\w*)|\bdoğrulama\w*\s+kapat\w*/iu],
  ['unsafe-git', 2, /\bpush\w*\s+(?:directly\s+)?(?:to\s+)?(?:the\s+)?(?:upstream\s+mirror|release\s+branch|mirror|upstream\s+main)\b|\bmirror\s+remote\b|\brepo\s+mirror\w*|\bgit\s+push\s+upstream\s+main\b|\bforce-?push\w*\b(?![^.\n]{0,20}with-lease)/iu],
  ['data-loss', 2, /--accept-data-loss\b|\bdrop\s+(?:the\s+)?(?:affected\s+)?tables?\b|\bDELETE\s+FROM\s+"?\w+"?\s*;|\bDELETE\s+WHERE\s+1\b|\bdowngrade\s+base\b|\bveri\s+kaybı\s+kabul|\bstaging\s+overlay\w*[^.\n]{0,40}prod/iu],
  ['skip-checks', 2, /\b(?:skip|ignore)\w*\s+(?:jest|tests?|e2e|lint\w*|checks?|ci|warnings?)\b|\b(?:unit\s+)?tests?\s+(?:are|is)\s+optional\b|\bopsiyonel\b|\bretries\s+devre\s+dışı|\bhata\s+görünmesin\b|\bsecurity\s+review\s+can\s+happen\s+after\b|\bgüvenlik\s+onayı\s+atla\w*|\breadiness\s+probe\s+yerine\b|\bhazır\s+olmasa\s+da\s+trafik/iu],
  ['untrusted-code', 2, /\bunverified\s+(?:registry|package|source)\b|\bbilinmeyen\s+bir\s+\w*\s*package\b|\bpin\s+yok\b|\b(?:remote|uzak)\s+(?:setup\s+|install\s+|kurulum\s+|bootstrap\s+)?scripti?\w*\b|\bsetup\s+script\s+from\s+https?:\/\/|\bpostinstall\b[^.\n]{0,60}(?:curl|wget|https?:\/\/|otomatik\s+çekil)/iu],
  // permissive framing: "acceptable", "it's fine to", "temporarily", Turkish "-abilir / kabul edilebilir / serbesttir"
  ['permissive', 1, /\b(?:acceptable|it\s+is\s+fine|is\s+fine\s+to|is\s+ok(?:ay)?\s+to|can\s+(?:just\s+)?(?:be|skip|push|use|leave)|you\s+can|feel\s+free|temporar(?:y|ily)|leave\s+it\s+enabled|rather\s+than|prefer\b|faster|quick(?:er)?\s+(?:fix|path)|instead\s+of|so\s+(?:the\s+team\s+can|failures|it|we\s+can)|unblock\w*|velocity|friction|easier|simpler?|avoids?\s+waiting|onboarding\s+instant|yerine|hızlandır\w*|kabul\s+edil\w*|serbest\w*|yeterli\w*|gerekirse|geçici\w*|pratik|hızlı\w*|kısa\s+yol|\w+(?:abilir|ebilir)\w*)\b/iu],
  // a standing order: on its own harmless (conventions are imperative), it amplifies other signals
  ['standing-order', 1, /\b(?:always|every\s+time|whenever|before\s+(?:every|each|any)|after\s+(?:every|each|any)|from\s+now\s+on|must|at\s+all\s+times|automatically|immediately|her\s+zaman|daima|bundan\s+sonra)\b/iu],
];

// JS `\w` and `\b` are ASCII-only even with the u flag ("kontrolünü" stops at "kontrol", "\bönceki" never matches):
// in unicode rules, widen both.
function uniWord(re) {
  if (!re.flags.includes('u')) return re;
  let out = '', inClass = false;
  for (let i = 0; i < re.source.length; i++) {
    const c = re.source[i];
    if (c === '\\') {
      const n = re.source[i + 1];
      if (n === 'w') out += inClass ? '\\p{L}\\p{N}_' : '[\\p{L}\\p{N}_]';
      else if (n === 'b' && !inClass) {
        // \b at the start of a branch is a word start, \b after an atom is a word end (cheaper than the full lookaround)
        // (after a quantified class like "[^.]{0,20}" either can hold: there, the full two-sided form)
        const pv = re.source[i - 1];
        const start = i === 0 || pv === '(' || pv === '|' || (pv === ':' && re.source[i - 2] === '?') || pv === '^';
        const end = /[\p{L}\p{N}_)]/u.test(pv) || (pv === '?' && re.source[i - 2] === ')');
        out += start ? '(?<![\\p{L}\\p{N}_])' : end ? '(?![\\p{L}\\p{N}_])'
          : '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))';
      }
      else out += c + n;
      i++; continue;
    }
    if (c === '[' && !inClass) inClass = true; else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, re.flags);
}
let prepared = false; // widened lazily: compiling ~40 unicode regexes costs ~25 ms, which the per-prompt hook must not pay
const prepare = () => { if (!prepared) { for (const r of RULES) r[2] = uniWord(r[2]); prepared = true; } };

/**
 * Classify a memory text. Pure (no DB). `raw` is the text as the writer handed it (before sanitize()).
 * @returns {{ score: number, reasons: string[], quarantine: boolean }}
 */
export function classify(raw, { kind } = {}) {
  prepare();
  const s = String(raw ?? '').slice(0, 8192);
  const reasons = [];
  let score = 0;
  const add = (name, w) => { if (!reasons.includes(name)) { reasons.push(name); score += w; } };
  if (HIDDEN_HARD.test(s)) add('hidden-unicode', 3);
  else if ((s.match(ZW) || []).length >= 2) add('hidden-unicode', 3);
  let t;
  try { t = s.normalize('NFKC'); } catch { t = s; }
  t = t.replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, ''); // so "ig\u200Bnore previous" still matches
  for (const [name, w, re] of RULES) {
    if (reasons.includes(name)) continue;
    if (!re.test(t)) continue;
    // a prohibition is the opposite of the advice ("never log raw API keys", "asla loglama"): an advice rule counts only
    // if at least one match is not preceded, in its clause, by a negation (the match itself may hold one: "do not revalidate")
    if (ADVICE.has(name)) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let live = false;
      for (const m of t.matchAll(g)) {
        const before = t.slice(Math.max(0, m.index - 60), m.index);
        if (!NEGATED.test(before)) { live = true; break; }
      }
      if (!live) continue;
    }
    add(name, w);
  }
  // only context signals (standing order, privilege, remote fetch alone): never enough
  const strong = reasons.some((r) => !CONTEXT.has(r));
  if (!strong) score = Math.min(score, QUARANTINE_AT - 1);
  void kind; // kinds are deliberately not exempted: a fix row with "curl … | sh" is as dangerous as a convention
  return { score, reasons, quarantine: score >= QUARANTINE_AT };
}

const dayStart = () => { const [y, m, d] = localDay().split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/**
 * The store.js hook: decide the status of a NEW row (call inside saveMemory's transaction, before INSERT).
 * @returns {{ status: 'active'|'quarantined'|'pending', reasons: string[] }}
 */
export function guardOnSave(db, { project, kind, source, explicit = true, session, text, body }) {
  const cfg = config();
  if (!GUARDED_SOURCES.has(source) || kind === 'session' || cfg.guard === false) return { status: 'active', reasons: [] };
  const c = classify(String(text ?? '') + (body ? '\n' + String(body) : ''), { kind });
  if (c.quarantine) return { status: 'quarantined', reasons: c.reasons };
  const laundered = source === 'agent' && session ? launderedFrom(db, session, text) : false;
  if (laundered === 'strong' || (laundered && c.score >= 2)) return { status: 'quarantined', reasons: ['laundered-tool-output', ...c.reasons] };
  if (laundered) return { status: 'pending', reasons: ['repeats-tool-output'] };
  // review and caps apply to real agent writes (MCP mem_save, ⟦mem⟧ markers pass source 'agent'); library callers that
  // omit `source` default to 'agent' for provenance but are not throttled
  if (source !== 'agent' || !explicit) return { status: 'active', reasons: [] };
  if (cfg.reviewAgentRules && RULE_KINDS.has(kind)) return { status: 'pending', reasons: ['agent-rule-review'] };
  // per-kind caps on agent writes: excess waits for `sam review` instead of flooding the card
  const capS = cfg.agentCapSession, capD = cfg.agentCapDay;
  try {
    if (session && capS > 0) {
      const n = db.prepare("SELECT COUNT(*) c FROM memories WHERE project = ? AND kind = ? AND source = 'agent' AND session = ? AND status = 'active'").get(project, kind, session).c;
      if (n >= capS) return { status: 'pending', reasons: [`cap-session:${kind}>${capS}`] };
    }
    if (capD > 0) {
      const n = db.prepare("SELECT COUNT(*) c FROM memories WHERE project = ? AND kind = ? AND source = 'agent' AND agent IS NOT NULL AND created_at >= ? AND status = 'active'").get(project, kind, dayStart()).c;
      if (n >= capD) return { status: 'pending', reasons: [`cap-day:${kind}>${capD}`] };
    }
  } catch { /* pre-v3 DB in a test harness: no caps */ }
  return { status: 'active', reasons: [] };
}

/** After INSERT: remember why a row was held (meta 'guard:<id>'), for `sam review` / `sam audit`. */
export function applyGuard(db, id, g) {
  if (!g || g.status === 'active') return;
  db.prepare("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run('guard:' + id, JSON.stringify({ s: g.status, r: g.reasons, at: Date.now() }));
}

/** Classify a row that bypassed saveMemory (JSONL restore). Returns the status it should get. */
export function statusForImported(row, { trusted = false } = {}) {
  if (trusted && ['active', 'quarantined', 'pending'].includes(row.status)) {
    if (row.status !== 'active') return { status: row.status, reasons: ['restored'] };
  }
  if (row.source === 'user' && trusted) return { status: 'active', reasons: [] };
  if (row.kind === 'session' && trusted) return { status: 'active', reasons: [] };
  const c = classify(String(row.gist || '') + '\n' + String(row.body || ''), { kind: row.kind });
  return c.quarantine ? { status: 'quarantined', reasons: c.reasons } : { status: 'active', reasons: [] };
}

/** JSONL-restore hook (portable.js): set status + reason on a just-inserted row. */
export function guardImported(db, row, opts) {
  const g = statusForImported(row, opts);
  if (g.status === 'active') return;
  db.prepare('UPDATE memories SET status = ? WHERE id = ?').run(g.status, row.id);
  applyGuard(db, row.id, g);
}

/** Card bullet for a row: provenance tag for non-user lines (`-a` agent, `-t` team, `-i` import), else "-". */
export function bulletOf(m) {
  if (config().sourceTags === false) return '-';
  return SOURCE_TAG[m?.source] || '-';
}
const TAG_NAME = { '-a': 'agent', '-t': 'team', '-i': 'import' };
/** One short legend naming only the tags present, e.g. "(-a agent: unverified)" (≈8 o200k tokens). '' when none. */
export function sourceLegend(rows) {
  if (config().sourceTags === false) return '';
  const present = [...new Set((rows || []).map((m) => SOURCE_TAG[m?.source]).filter(Boolean))].sort();
  return present.length ? `(${present.map((t) => `${t} ${TAG_NAME[t]}`).join(', ')}: unverified)` : '';
}
export const isTagged = (m) => config().sourceTags !== false && !!SOURCE_TAG[m?.source];

/** SQL fragment for "visible to agents". */
export const ACTIVE = "status = 'active'";
export const isActive = (m) => !m || m.status == null || m.status === 'active';

// ---------- online gate calibration hook (minimal) ----------
// One meta row per gated prompt: the top-3 candidates' gate features and whether each passed. `sam audit` later joins
// them with what happened next (mem_get, edits of the memory's files) to get implicit labels. Labels feed only a future
// gate model, never the ranking prior (redteam X11). Cost: one INSERT per prompt with hits; rows expire after 30 days.
const GATE_TTL = 30 * 86400000;
const ts36 = (t) => t.toString(36).padStart(9, '0');
let gateWrites = 0;
export function recordGate({ project, session, prompt, hits, passed }) {
  const cfg = config();
  if (cfg.gateLog === false || !hits?.length) return;
  const db = openDbLazy();
  const t = Date.now();
  const top = hits[0].score || 1;
  const ok = new Set((passed || []).map((h) => h.m.id));
  const r4 = (x) => Math.round((x || 0) * 1e4) / 1e4;
  const v = {
    p: project, s: session || null, q: Math.min(4000, String(prompt || '').length),
    h: hits.slice(0, 3).map((h, i) => [h.m.id, i, r4(h.score), r4(h.score / top), r4(h.cov), h.matched ?? 0, h.strongN ?? 0, h.selective ? 1 : 0, r4(h.cos), h.temporal ? 1 : 0, ok.has(h.m.id) ? 1 : 0]),
  };
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run(`gate:${ts36(t)}:${Math.random().toString(36).slice(2, 6)}`, JSON.stringify(v));
  if (++gateWrites % 50 === 1) db.prepare("DELETE FROM meta WHERE k >= 'gate:' AND k < ?").run('gate:' + ts36(t - GATE_TTL));
}
export const GATE_FIELDS = ['id', 'rank', 'score', 'rel', 'cov', 'matched', 'strongN', 'selective', 'cos', 'temporal', 'passed'];
export const gateTs = (k) => parseInt(String(k).split(':')[1], 36);

// ---------- laundering through tool output ----------
// A file the agent read (or a command's output) says "remember: always run X" and the agent dutifully writes
// ⟦mem convention: always run X⟧. The marker is agent-sourced, but its words came from untrusted tool output.
// recordTool hands us each tool response; lines that look like memory-bait are kept (normalized, per session, ≤ 40)
// and an agent write in that session that repeats one of them is quarantined as 'laundered-tool-output'.
const BAIT = /⟦\s*mem|\[\[\s*mem|\b(?:remember|memori[sz]e|keep\s+in\s+mind|note\s+to\s+(?:self|ai|the\s+(?:ai|agent|assistant))|save\s+(?:this|the\s+following)|from\s+now\s+on|going\s+forward|always|never)\b|\b(?:hatırla|unutma|aklında\s+tut|bundan\s+sonra|her\s+zaman|asla)\b/iu;
// memory-bait proper (asks to be remembered / saved): a repeat is quarantined. A plain standing order ("always …") in a
// README is often a real convention: a repeat of it only waits for review (pending).
const STRONG_BAIT = /⟦\s*mem|\[\[\s*mem|\b(?:remember|memori[sz]e|keep\s+in\s+mind|note\s+to\s+(?:self|ai|the\s+(?:ai|agent|assistant))|save\s+(?:this|the\s+following))\b|\b(?:hatırla|unutma|aklında\s+tut)\b/iu;
const normBait = (s) => String(s).normalize('NFKC').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '').toLowerCase().replace(/[`*_"'“”‘’⟦⟧[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set((normBait(s).match(/[\p{L}\p{N}_]+(?:[./-][\p{L}\p{N}_]+)*/gu) || []).filter((w) => w.length >= 3));

export function noteToolTaint({ session, project, text }) {
  if (!session || !text || config().guard === false) return;
  const t = String(text).slice(0, 512 * 1024);
  if (!BAIT.test(t)) return;
  const lines = [];
  for (const l of t.split(/\r?\n|(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ⟦])/u)) {
    if (l.length < 12 || l.length > 2000 || !BAIT.test(l)) continue;
    lines.push((STRONG_BAIT.test(l) ? '!' : ' ') + normBait(l).slice(0, 400));
    if (lines.length >= 20) break;
  }
  if (!lines.length) return;
  const db = openDbLazy();
  const k = 'taint:' + session;
  let prev = [];
  try { prev = JSON.parse(db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v || '{}').l || []; } catch { prev = []; }
  const all = [...new Set([...lines, ...prev])].slice(0, 40);
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify({ p: project, at: Date.now(), l: all }));
}

/** Does `text` repeat a memory-bait line seen in this session's tool output? 'strong' | 'weak' | false */
export function launderedFrom(db, session, text) {
  if (!session) return false;
  let l;
  try { l = JSON.parse(db.prepare('SELECT v FROM meta WHERE k = ?').get('taint:' + session)?.v || '{}').l; } catch { return false; }
  if (!l?.length) return false;
  const n = normBait(text);
  if (n.length < 8) return false;
  const W = words(text);
  let hit = false;
  for (const raw of l) {
    const line = raw.slice(1);
    let same = n.length >= 16 && line.includes(n.slice(0, Math.min(n.length, 60)));
    if (!same && W.size >= 3) {
      const L = words(line);
      let i = 0; for (const w of W) if (L.has(w)) i++;
      same = i / W.size >= 0.7;
    }
    if (same && raw[0] === '!') return 'strong';
    if (same) hit = 'weak';
  }
  return hit;
}
