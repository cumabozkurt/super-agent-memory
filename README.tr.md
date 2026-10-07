# SAM — Super Agent Memory

**Tüm kodlama ajanların için tek, kalıcı ve token-tasarruflu bellek.**
Claude Code · Codex CLI · Gemini CLI · Antigravity (IDE / CLI / 2.0) · OpenCode · Cursor · her MCP istemcisi.

[English README](README.md)

```
npm i -g super-agent-memory   # ya da: git clone … && npm link
sam install                   # ajanlarını bulur; hook + MCP + kuralları kurar
```

Kurulum bu kadar. Sunucu, API anahtarı, Python ya da Docker gerekmez; **sıfır npm bağımlılığı** var. Gereksinim: **Node.js 22.16+ (22.x) ya da 24+**. `~/.sam/sam.db` adlı tek SQLite dosyasını aynı ortamdaki tüm ajanlar aynı anda kullanır. Claude Code'da alınan bir kararı Codex, Gemini ve OpenCode bir sonraki açılışta bilir.

Paket aynı CLI için üç ad kurar: `sam`, **`sam-memory`** ve `super-agent-memory`. Makinende `sam` AWS SAM CLI ise `sam-memory` kullan; SAM'in ajanlar için kurduğu kurallar her zaman `sam-memory` kullanır.

---

## Neden?

Son bir yılda güncellenen, en çok yıldızlı **50 ajan-bellek reposunu** README ve kaynak koduyla uçtan uca inceledik ([docs/RESEARCH.md](docs/RESEARCH.md)). Hepsinde aynı beş sorun çıktı. SAM'in cevapları:

| Sorun | SAM'in çözümü |
|---|---|
| Bellek bağlama toptan dökülüyor, her turda binlerce token gidiyor | **Bütçeli, kademeli bağlam.** Oturum başında ≤320 tokenlık (o200k eşdeğeri) proje kartı gelir. Prompt başına hatırlatma yalnızca alaka eşiği geçilirse eklenir (≤160 token). Gerisi `mem_search` ile `[tür] özet #id` satırları olarak bir arama uzağında durur |
| Aynı bellekler her turda yeniden gönderiliyor | **Oturum defteri.** Bir bellek aynı oturumda iki kez gönderilmez; defter yalnızca bağlam sıkıştırıldıktan (compaction) sonra sıfırlanır |
| Her yazma ya da araç olayı için ayrı bir LLM çağrısı yapılıyor | **LLM'siz yakalama.** Düzenlemeler, komutlar, sonuçlar ve hata→düzeltme çiftleri deterministik olarak kaydedilir. Ajan bir şeyi kaydetmek için yanıtına `⟦mem decision: kuyruk: SQS, Kafka değil⟧` yazar; bu araç çağrısı gerektirmez |
| 19–54 araçlı MCP sunucuları her oturumda binlerce token şema yükü getiriyor | **4 araç, yaklaşık 270–310 tokenlık şema** (o200k/Claude 4.6; Claude 4.7+'da yaklaşık 440). İstersen MCP'siz de kullanılır: her işlem bir `sam-memory` komutu olarak da var |
| Test ve build çıktıları bağlamı dolduruyor | **Çıktı kasası.** `sam run -- npm test` tam çıktıyı yerelde saklar, ajana yalnızca özeti (bağlamıyla hatalar + son satırlar) gösterir. 1.800 testlik bir log 20.652 tokendan 89 tokena iner |

### Ölçümler

**Token ölçümü** (`npm run bench`): sentetik bir proje (600 kayıt, yakın kopyalar birleştikten sonra 540 canlı bellek) ve 30 promptluk bir oturum. Promptların 20'si kayıtlı belirli bir belleğe ihtiyaç duyuyor, 10'u alakasız.

| Strateji | Bağlama giren token | Gereken bellek ajana ulaştı mı |
|---|---:|---:|
| A. Oturum başında tüm belleği dökmek (memory-bank / büyük CLAUDE.md tarzı) | 35.608 | 20/20 |
| B. Her promptta en iyi 10 kaydın tam metni (yaygın varsayılan) | ≈32.100 | 20/20 |
| D. Her promptta saf BM25 ilk 3 (eşik yok, defter yok) | ≈2.530 | 13/20 |
| **C. SAM** (kart + eşikli hatırlatma + defter) | **≈2.100** | **20/20** |

**Aynı isabetle tam dökümden yaklaşık %94 daha az token; saf BM25'ten de daha az token ve çok daha iyi isabet.** SAM, alakasız 10 promptun tamamına toplam yaklaşık 140 token harcadı (BM25: yaklaşık 425). Bellek kimlikleri rastgele olduğundan tekrarlanan çalıştırmalar birkaç düzine token farklı çıkar (6 çalıştırmada 2.073–2.110, hepsi 20/20). Token sayımı SAM'in tahmincisiyle yapılır (tiktoken o200k'ye göre yaklaşık ±%5). A ve B, incelenen repolarda sık görülen yaklaşımların temsilleridir, belirli projelerin yeniden yazımı değildir. Veri şablonla üretildiği için sözcüksel aramayı kayırır; sayıları yol gösterici kabul et. Ölçüm kodu `bench/tokens.js` dosyasında.

**Modellere göre token.** Bütçeler ve yukarıdaki sayılar o200k eşdeğeri birimdedir (SAM'in tahmincisi, tiktoken o200k'ye göre ayarlı). Her model ailesi aynı metni farklı tokenlara böler, yani gerçek sayı ajana göre değişir. SAM'in kendi çıktısı, her sağlayıcının kendi tokenizer'ıyla ölçüldü (OpenRouter `usage.prompt_tokens`, 2026-10-07):

| SAM metni | o200k | Claude 4.6 | Claude 4.7+ / 5.x | Gemini 3.x |
|---|---:|---:|---:|---:|
| Oturum kartı (EN) | 299 | 334 (1,12×) | 453 (1,52×) | 326 (1,09×) |
| Oturum kartı (TR) | 281 | 358 (1,27×) | 469 (1,67×) | 297 (1,06×) |
| Prompt başına hatırlatma (EN) | 34 | 38 (1,12×) | 51 (1,50×) | 36 (1,06×) |
| Bellek özetleri (TR) | 239 | 335 (1,40×) | 453 (1,90×) | 243 (1,02×) |
| MCP araç şemaları (4 araç) | 268 | 309 (1,15×) | 443 (1,65×) | 280 (1,04×) |

Yani 320 tokenlık kart GPT ve Gemini modellerinde yaklaşık 320, Claude 4.7 ve sonrasında yaklaşık 485–540 token tutar. Türkçe metin o200k ve Gemini'de İngilizcenin 1,24–1,34 katı, Claude'da 1,40–1,69 katıdır. Token ölçümündeki tasarruf oranı SAM ile alternatifleri aynı birimde karşılaştırır; her tokenizer için ayrıca ölçülmedi. Betik: `bench/native-tokens.mjs`.

**Erişim (retrieval) ölçümü** (`npm run bench:retrieval`): üç proje + genel bellek ve otomatik yakalama gürültüsü içinde elle yazılmış 411 bellek, derecelendirilmiş etiketli 239 İngilizce ve Türkçe prompt (32'si alakasız), 40 turluk bir oturum ve proje başına "bilinmesi şart" listesi. Eşik ayarları yalnızca tek numaralı yarıda ayarlandı; çift numaralı yarı ayrılmış (held-out) test kümesidir.

| | dev-2 | dev-3 | **1.0.0** |
|---|---:|---:|---:|
| arama Recall@3 / MRR | 0.771 / 0.749 | 0.886 / 0.852 | **0.886 / 0.852** |
| Recall@3, Türkçe ↔ İngilizce promptlar (35) | 0.495 | 0.848 | **0.848** |
| Recall@3, cevapla hiç ortak kelimesi olmayan promptlar (22) | 0.091 | 0.500 | **0.500** |
| prompt başına hatırlatma: cevap eklendi | 0.775 | 0.845 | **0.845** |
| alakasız promptlarda yanlış ekleme oranı | 0.750 | 0.500 | **0.500** |
| prompt başına token | 103 | 85 | **85** |
| oturum kartı: "bilinmesi şart" listesinin kapsanan payı | 0.16 | 0.35 (295 token) | **0.73** (1.005 token, küçük-store dökümü) |
| ayrılmış yarı: Recall@3 · cevap eklendi · yanlış ekleme | 0.760 · 0.750 · 0.938 | 0.902 · 0.868 · 0.500 | **0.902 · 0.868 · 0.500** |
| 40 turluk oturum: toplam token | 3.479 | 2.365 | **2.386** |

(dev-2/dev-3 yayımlanmamış geliştirme sürümleridir.) Ölçümdeki üç projenin her birinde not dışı en fazla 40 bellek var; bu yüzden 1.0.0 onlara sıralı kart yerine deterministik bir tam döküm verir. Ayrıntılar, bölmeler ve çekinceler [bench/retrieval/README.md](bench/retrieval/README.md) dosyasında (İngilizce). Bu sayıların hiçbiri için embedding gerekmez.

**Kör ölçüm** (`npm run bench:v2`): bir model sağlayıcısının yazdığı, başka bir sağlayıcının yargıladığı 539 pozitif ve 858 negatif EN/TR prompt; hash ile ayar (dev) ve ayrılmış (held-out) yarılara bölünmüş. Negatifler başka stack, başka proje, alakasız kodlama, sohbet ve "yakın ıska" promptlarıdır.

| ayrılmış yarı (265 pozitif, 418 negatif) | cevap eklendi [%95 GA] | yanlış ekleme [%95 GA] |
|---|---:|---:|
| **SAM 1.0.0** (ilgi eşiği + projeye özgülük kapısı) | **0.699** [0.647, 0.752] | **0.144** [0.110, 0.177] |
| özgülük kapısı olmadan SAM | 0.699 | 0.275 [0.234, 0.318] |
| BM25 ilk 3, eşik yok | 0.903 | 0.935 |
| dev yarısında SAM'in isabetine göre ayarlanmış skor eşikli BM25 ilk 3 | 0.741 | 0.124 |

Özgülük kapısı başka stack enjeksiyonlarının neredeyse tamamını (0.35 → 0.01), başka proje enjeksiyonlarının çoğunu (0.25 → 0.06) isabet kaybı olmadan kaldırır. Ayarlanmış bir BM25 eşiği bu sette güçlü bir taban; SAM'in eşiği ise store'a özel ayar istemez ve SAM üstüne kartı ve defteri ekler. Aynı koşu şunları da ölçer: zehirlenme (koruma, ajanın yazdığı 48 zehirli notun 43'ünü karantinaya alır; zehirli bir notun konuyla ilgili bir prompta eklenme oranı %79'dan %10'a iner), bilgi güncelleme ve dedup ([CHANGELOG](CHANGELOG.md) içindeki *Known limitations*), süreç içi hatırlatma gecikmesi (p50 ≈6 ms, bunun ≈0,5 ms'si özgülük kapısı). Tam rapor: `bench/retrieval-v2/results/1.0.0.txt`.

**Kodlama değerlendirmesi** (`npm run bench:coding`): yalnızca kayıtlı bir proje bilgisiyle çözülebilen 34 kodlama görevi (26 EN, 8 TR) ve 10 zarar görevi, testlerle notlanıyor; üç model/store koşulu (50 ve 270 satırlık store'da gemini-3.8-flash, 50 satırlıkta deepseek-v4-flash; 1.899 notlanmış çağrı, eşleştirilmiş görev kümesi bootstrap'i).

| kol | geçen görev | belleksize göre Δ [%95 GA] | eklenen bağlam tokenı |
|---|---:|---:|---:|
| bellek yok | %16,7 | — | 0 |
| aynı boyutta ilgisiz bellek | %20,6 | +3,9 [−0,5, +9,8] | 379 |
| SAM yalnızca push (kart + hatırlatma) | %72,1 | +55,4 [+40,2, +69,1] | 380 |
| **SAM push + pull** (`mem_search` / `mem_get`) | **%93,1** | **+76,5 [+63,2, +88,7]** | 380 + çekilenler |
| store'un tam dökümü | %94,6 | +77,9 [+64,7, +89,7] | 4.603 |

SAM, tam dökümün yaklaşık on ikide biri tokenla onunla başa baş; zarar oranı her kolda %1,8–5,3, ölçülebilir fark yok. *Başarısız bir komuttan sonra* düzeltme kartı göndermek başarısız denemelerin +19,7 puanını [+4,5, +38,8] kurtardı ve yayında; sürekli açık "deneyim push"u fayda etmedi (−1,5 puan) ve yayında değil. Yöntem ve görev tabloları: `bench/coding-eval/`.

**Hook gecikmesi** (`npm run bench:latency`, her prompt için yeni süreç, 60 bellek, Linux x64, Node 22.23): medyan ≈86 ms, bunun ≈26 ms'si Node açılışı (son geliştirme sürümü aynı makinede ≈79 ms ölçüldü; yani 1.0.0'ın koruması, kapıları ve handoff'ları ≈7 ms ekliyor; koşudan koşuya gürültü yaklaşık ±10 ms).

---

## Nasıl çalışır?

```
 Claude Code ─┐  hook'lar: SessionStart · UserPromptSubmit · PostToolUse(+Failure) · PreCompact · Stop · Subagent*
 Codex CLI ───┤  hooks.json (aynı olaylar) + config.toml MCP
 Gemini CLI ──┤  SessionStart · BeforeAgent · AfterTool · PreCompress · AfterAgent · SessionEnd
 Antigravity ─┤  PreInvocation (injectSteps) · PostToolUse · Stop  + mcp_config.json + kurallar
 OpenCode ────┤  eklenti: chat.message · tool.execute.after · session.idle · compacting
 Cursor ──────┤  hooks.json: sessionStart · postToolUse(+Failure) · afterAgentResponse + MCP
 diğer MCP ───┘  MCP + kurallar (`sam snippet`)
        │
        ▼   ~/.sam/bin/sam hook <olay> --agent <ad>   (başlatıcı Node'u bulur; Linux'ta prompt başına ≈70–90 ms, Node açılışı dahil, `npm run bench:latency`; ajanı asla bloklamaz)
 ┌──────────────────────────── SAM motoru (Node 22.16+/24, node:sqlite) ───────────────────────┐
 │ yakalama  promptlar → yönergeler ("bundan sonra…", "unutma…") · düzenlemeler · komut+sonuç│
 │           hata→düzeltme tespiti · yalnızca asistanın kendi metnindeki ⟦mem⟧ işaretleri      │
 │ depolama  türlü bellekler · köken (user/agent/auto/team/import) · yakın kopya birleştirme  │
 │           yerine geçme ("konu: değer", "Y yerine X", olumsuzlar) · gizli bilgi maskeleme    │
 │ erişim    BM25 + trigram + EN/TR eş anlam genişletme [+ isteğe bağlı embedding] → RRF       │
 │           × kavram kapsamı × önem × yenilik (önemli kararlar için taban değerle)            │
 │ enjeksiyon bütçeli kart · kanıt eşikli hatırlatma · dosya notları · alt ajan kartı · defter│
 │ kasa      tam komut çıktısı saklanır, özet gösterilir, gerekince `sam-memory out <id>`     │
 │ bakım     `sam gc` (günde bir hafif çalışma da var): süresi dolanı sil, birleştir, arşivle │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
        ▲
        └── açık hatırlama/kaydetme için MCP (4 araç) ve CLI; Markdown/JSONL dışa aktarma; git'te ekip dosyası
```

Ajanın oturum başında gördüğü (`sam context` komutunun gerçek çıktısı, 172 token):

```
<memory project="shop">
conventions the user recorded:
- commit mesajlarını İngilizce yaz
- package manager: pnpm, never npm
user preferences:
- answer in Turkish, code comments in English
decisions (newest wins):
- auth: JWT in an httpOnly cookie, refreshed every 15 min · 10-07
- test runner: vitest with --pool=forks; threads crash on Node 22 · 10-07
facts:
- Stripe webhooks are verified with STRIPE_WEBHOOK_SECRET in... · 10-07 #vs0h
saved inline: ⟦mem decision: <subject>: <value>⟧ (same subject replaces the old value; no status notes) · more: mem_search → mem_get(#id)
</memory>
```

*"how do we verify the stripe webhook signature?"* promptu için (39 token):

```
<memory recall>
- (fact 10-07) Stripe webhooks are verified with STRIPE_WEBHOOK_SECRET in src/billing/webhook.ts #vs0h
</memory>
```

Kararlar ve bilgiler tarihleriyle, en yenisi önce listelenir; böylece model iki satırdan hangisinin güncel olduğunu anlar. `#id` yalnızca `mem_get` satırda görünenden fazlasını döndürecekse yazılır. Kurallar kullanıcının *"Bundan sonra commit mesajlarını İngilizce yaz"* demesinden, kararlar ajanın yanıtındaki satır içi bir `⟦mem⟧` işaretinden, düzeltmeler başarısız → düzenlenmiş → geçen bir test çalıştırmasından gelebilir. Hiçbirinde model çağrısı yoktur.

Kartta başlıklar ve kayıt kuralı satırı İngilizcedir (modeller için); bellek metni hangi dilde kaydedildiyse o dilde görünür.

Tasarım ayrıntıları [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) dosyasında (İngilizce).

---

## Entegrasyonlar

`sam install` yüklü ajanları otomatik bulur. Seçmek için `sam install claude codex …` ya da `--all`, önizlemek için `--dry-run` kullan. Kurulum küçük bir başlatıcı yazar (`~/.sam/bin/sam`; Windows'ta ayrıca `sam.cmd`/`sam.ps1`). Hook ve MCP kayıtları bu başlatıcıyı çağırır; böylece Node'u güncellemek ya da değiştirmek (Homebrew, nvm, Volta) hook'ları bozmaz. Kurulumdan sonra kurulan her komut ajanın gerçek kabuğunda bir kez çalıştırılır ve `self-test: …` satırı yazılır. Değişen her dosyanın tek seferlik bir `.sam-bak` yedeği alınır; `sam uninstall` eklenenleri, yedekleri ve kurulumun oluşturup yeniden boş kalan dosyaları kaldırır.

| Ajan | Kurulan |
|---|---|
| **Claude Code** | `settings.json` hook'ları (`compact`/`fork` dahil her kaynak için SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact, Stop, SessionEnd, SubagentStart, SubagentStop); MCP `claude mcp add --scope user` ile (ya da `.claude.json`); `skills/sam-memory` becerisi. `CLAUDE_CONFIG_DIR` dikkate alınır |
| **Codex CLI** | `config.toml` (`[mcp_servers.sam]`), `hooks.json`, `AGENTS.md` bloğu, `~/.agents/skills/sam-memory` becerisi (Gemini CLI ve OpenCode ile ortak). `CODEX_HOME` dikkate alınır. **Codex kullanıcı hook'larını ancak `/hooks` ile bir kez onayladıktan sonra çalıştırır** |
| **Gemini CLI** (eski: 2026-06-18'den beri yalnızca ücretli API anahtarı ve Code Assist lisanslarıyla; yerini Antigravity `agy` aldı) | `~/.gemini/settings.json` (`mcpServers.sam` + hook'lar); `~/.gemini/GEMINI.md` bloğu |
| **Antigravity** | `~/.gemini/config/mcp_config.json` (varsa eski `~/.gemini/antigravity/mcp_config.json` de); olay başına bir sarmalayıcıyla `~/.gemini/config/hooks.json` (PreInvocation → `injectSteps`, PostToolUse, Stop); `~/.gemini/config/` altında kural ve beceri |
| **OpenCode** | `opencode.json(c)` MCP + `sam-memory.md` için `instructions` kaydı (global bir `AGENTS.md` asla oluşturulmaz; o dosya `~/.claude/CLAUDE.md`'yi gölgelerdi); eşzamansız eklenti `plugins/sam-memory.js`. `XDG_CONFIG_HOME` dikkate alınır |
| **Cursor** | `~/.cursor/mcp.json` (`type: stdio`); `~/.cursor/hooks.json` (sessionStart kartı, postToolUse'ta dosya notları, prompt yakalama, afterAgentResponse'ta işaret toplama, preCompact, sessionEnd). Cursor'da prompt başına ekleme hook'u olmadığından prompt başına hatırlatma orada MCP üzerinden olur. Cursor `~/.claude` / `.claude` hook'larını da çalıştırır (Third-Party Imports varsayılan açık; `cursor-agent`'ta hep açık): SAM'in Claude hook'ları Cursor'u tanır (`cursor_version` / `CURSOR_VERSION`) ve SAM'in Cursor hook'ları kuruluysa (kullanıcı ya da proje düzeyinde) sessiz kalır, böylece hiçbir şey iki kez çalışmaz |
| **Diğerleri** (Windsurf, Cline, Zed, Copilot, Roo, Goose…) | `sam snippet` MCP JSON'unu ve kural bloğunu yazdırır |

Bir ajanın hook sistemi değişirse yakalama zarifçe azalır: MCP, kurallar ve CLI çalışmaya devam eder. `sam doctor`, artık var olmayan yolları gösteren kayıtları bildirir (`BROKEN: … → sam install çalıştır`).

### Windows

- Hook komutları ajanın kabuğuna göre üretilir: Claude Code ≥ 2.1.139 exec biçimini kullanır (kabuk yok); daha eski Claude varsa Git Bash'i, yoksa PowerShell'i kullanır; Gemini CLI ve Cursor PowerShell (`& '…\sam.cmd' …`), Codex cmd tırnaklaması alır. Kabuksuz çalıştıran ajanlar (Claude exec biçimi, MCP kayıtları, OpenCode eklentisi) doğrudan `node.exe` + `sam.js` çağırır.
- `sam run` kuruluysa Git Bash'i, yoksa PowerShell'i, o da yoksa cmd'yi kullanır (`SAM_SHELL=bash|powershell|cmd` ile değiştirilebilir). UTF-8 olmayan konsol kod sayfasındaki çıktılar (CP857, Windows-1254, …) doğru çözülür; `SAM_VAULT_ENCODING` ile zorlanabilir.
- Windows desteği CI'da (Windows × Node 22.16/24) ve benzetimli komut üretimiyle sınanır; her kabuk biçiminin gerçek ajanlarda çalıştırılması POSIX kadar yıpranmış değildir. `sam doctor` kurulanı kendisi sınar.

### Ortam başına bir veritabanı

SQLite'ın WAL kipi tek bir çekirdekte paylaşılan bellek ister. Her ortam için ayrı, yerel bir `SAM_HOME` kullan: Windows, her WSL dağıtımı, her konteyner ya da devcontainer, her SSH sunucusu. `SAM_HOME`'u WSL'den `/mnt/c/…` yoluna, NFS/SMB/9p/FUSE bağlamasına, ana makineyle paylaşılan Docker Desktop bind mount'una ya da Dropbox / iCloud Drive / OneDrive / Google Drive klasörüne yönlendirme. Veritabanı yine de böyle bir dosya sistemindeyse SAM, WAL yerine daha yavaş geri alma günlüğünü (rollback journal) kullanır ve `sam doctor` / `sam install` uyarır (bağlamanın güvenli olduğunu biliyorsan `SAM_ALLOW_SHARED_FS=1` WAL'ı zorlar).

Bellekleri ortamlar arasında `sam export --jsonl` / `sam import --trusted` ile taşı ya da proje bilgisini commit edilmiş bir `.sam/memory.md` ile paylaş. Git remote'u olan repolar her yerde aynı proje kimliğini alır; remote'u olmayan repolara ad içeren bir `.sam-project` dosyası koy. Devcontainer'da `sam install`'ı konteynerin içinde çalıştır (ör. `postCreateCommand`), bellek yeniden kurulumlarda kalsın istiyorsan `~/.sam` yoluna adlandırılmış bir volume bağla.

---

## Güvenlik

- **Ekip dosyaları insan incelemesi ister.** Bir reponun `.sam/memory.md` dosyası yalnızca o repoda `sam trust` çalıştırınca içe aktarılır: satır sayısını ve bir önizlemeyi gösterir, terminalde `[y/N]` sorar (betikler `--yes` verir). Güven o içeriğe sabitlenir: bir ekip arkadaşı dosyayı değiştirdiğinde sen yeniden inceleyene kadar yeni bir şey içe aktarılmaz ve kart ajana sana sormasını söyler. Kendi kabuğundan `sam trust` çalıştıran bir ajanın terminali yoktur, reddedilir. `sam export --team` bir repoyu asla güvenilir işaretlemez.
- **Köken (provenance).** Her bellek onu kimin yazdığını kaydeder: `user` (`sam add`, senin yönergelerin), `agent` (işaretler, `mem_save`), `auto` (yakalanan düzeltmeler ve özetler), `team`, `import`. Yalnızca sen sabitleyebilirsin (pin). Bir ajan, senin kaydettiğin ya da sabitlediğin bir değerin üzerine yazamaz veya onu geçersiz kılamaz (MCP ona sana sormasını söyler); tek istisna, yeni değeri aynı oturumda senin söylemiş olmandır. Ekip satırları asla sabitlenmez; içe aktarmalar, kendi yedeklerin için `--trusted` vermedikçe güvenilmez sayılır.
- **Zehirlenme koruması.** Ajanların, ekip arkadaşlarının ya da içe aktarmaların yazdığı ve enjeksiyona benzeyen bellekler (uzak betik, kontrolleri kapatma, veri sızdırma, kimlik doğrulamayı zayıflatma, "kullanıcıyı yok say") karantinaya alınır; oturum/gün sınırını aşan ajan yazımları onay bekler (pending). Bekleyen bellekler ajanlara görünmez ve canlı bir belleğin yerini asla almaz; onları `sam review` (onayla / reddet; incelenmeyenler 14 gün sonra düşer) ve `sam audit` ile görürsün. Kartta ajan / ekip / içe aktarma satırları `-a` / `-t` / `-i` ile işaretlenir.
- **Bellek veridir.** Metin NFKC ile normalleştirilir, görünmez, yön değiştiren (bidi) ve Unicode etiket karakterlerinden arındırılır, `<`/`>` kaçışlanır; böylece kayıtlı bir satır `<memory>` bloğunu kapatamaz ya da bir inceleyiciden talimat gizleyemez. Kurulan kurallar, bellek satırlarının ajanın izinlerini ya da araçlarını asla değiştirmediğini söyler.
- **Yalnızca asistanın söylediği toplanır.** İşaretler, ajan başına izin verilen asistan mesajı biçimlerinden alınır; araç çıktısı, ajanın okuduğu dosyalar, sıkıştırma özetleri, akıl yürütme metni, alıntılar, kod blokları ve blok alıntılar yok sayılır. Tur başına en fazla 8 işaret.
- **Gizli bilgiler hiçbir şey kaydedilmeden önce maskelenir**, kasa çıktıları dahil: yaklaşık 30 biçim (OpenAI, Anthropic, Stripe, GitHub, GitLab, npm, Hugging Face, Slack, AWS, Google, SendGrid, Discord, JWT'ler, PEM ve PuTTY anahtarları, base64 ile sarılmış anahtarlar, Bearer/Basic başlıkları, URL parolaları, `curl -u`, `*_PASSWORD=`, `"token": "…"`). Maskeleme kötü niyetli girdide de doğrusal sürede çalışır.
- **MCP kapsamlıdır.** `mem_get` ve `mem_forget` yalnızca geçerli projeyi ve genel belleği görür; argümanların uzunluğu sınırlıdır, aşırı büyük istekler reddedilir.
- **`sam run`**, kabuk operatörleri içeren tek bir tırnaklı argümanı `--shell` verilmedikçe reddeder. Bir ajanda `sam run` onayı yine de `--` sonrasındaki her şeyi onaylar; bunu bir kabuğu onaylamak gibi düşün.
- **Silme hakkı.** `sam purge` içeriği her tablodan (bellekler ve eski sürümleri, ham olaylar, ilk promptlar, kasa, özetler, handoff'lar, ekip dosyası) siler ve veritabanını yeniden yazar; bir parmak izi (tombstone) tekrar yakalanmasını engeller. `sam forget --hard` da parmak izi bırakır.
- **Dosyalar ve kurulum.** `~/.sam` 0700, veritabanı dosyaları 0600 izinlidir; `sam forget --hard` güvenli siler ve arama dizinini temizler. Kurulum, sembolik bağlantı olan bir yapılandırma dosyasının içine asla yazmaz. Yerel olmayan bir embedding uç noktası yalnızca `~/.sam/config.json` buna izin verirse kullanılır, tek başına bir ortam değişkeniyle asla.

Güvenlik açıklarını [SECURITY.md](SECURITY.md) dosyasındaki gibi bildir. Denetimler (kod, ajan entegrasyonları ve v1.1.0'ın altı bakış açılı denetimi) [docs/AUDIT.md](docs/AUDIT.md) ve [docs/AUDIT2.md](docs/AUDIT2.md) dosyalarında özetlenmiştir (İngilizce).

---

## Kullanım

Çoğu zaman bir şey yapman gerekmez; yakalama ve enjeksiyon otomatik çalışır. İşe yarayan komutlar (`sam` ile `sam-memory` aynıdır):

```bash
sam q "stripe webhook"            # ara → [tür] özet #id
sam get 29on 17vc                 # tam ayrıntı
sam add "deploy: fly.io via GH Actions" -k decision --pin
sam context --prompt "login'i düzelt"   # ajanın tam olarak ne alacağını token sayısıyla gör
sam run -- pnpm test              # çıktı kasası: şimdi özet, sonra `sam out <id> --grep FAIL`
sam stats                         # enjekte edilen ve bağlam dışında tutulan token
sam export --team                 # <repo>/.sam/memory.md dosyasını yaz, commit et
sam trust                         # ekip arkadaşları: dosyayı incele, sonra içe aktarmaya izin ver (varsayılan: kapalı)
sam doctor                        # tespit, veritabanı sağlığı, ayar sorunları, bozuk yollar, öz sınama
sam doctor --repair               # arama dizinini yeniden kur ya da hasarlı veritabanını kurtar
sam gc                            # bakım (günde bir kez kendiliğinden hafifçe de çalışır)
sam review                        # bekleyen bellekler (karantina / onay bekleyen): onayla ya da reddet
sam audit                         # kim ne yazdı, ne enjekte ediliyor, karantina nedenleri
sam purge --query "eski api anahtarı"   # içeriği her yerden sil (+ parmak izi), sonra VACUUM
sam handoff "auth bitti; refresh testleri kaldı" --to codex   # bu repodaki bir sonraki codex oturumu bunu bir kez alır
```

Ajana doğrudan *"unutma…"*, *"bundan sonra…"*, *"artık X değil Y"*, *"her zaman / asla…"* (İngilizce: *"remember that…"*, *"from now on…"*) demen de yeterli. Bunlar kural, tercih ya da karar olarak kaydedilir; tekrarlanan çok adımlı işler `-k procedure` ile prosedür olarak kaydedilebilir. Kararları `konu: değer` biçiminde yaz (`kuyruk: SQS, Kafka değil`): aynı konuya verilen yeni bir değer eskisinin yerini alır; "Y yerine X" ve "Y'den X'e geçtik" de öyle. "Yarın…" gibi zaman bildiren cümleler iki gün sonra kendiliğinden kalkan geçici bir yapılacak olarak saklanır.

Çıkış kodları: 0 başarı, 1 bulunamadı ya da başarısız bir kontrol, 2 kullanım hatası. `SAM_DEBUG=1` yığın izini gösterir.

### Ayarlar

Değerleri `~/.sam/config.json` dosyasında ya da ortam değişkeniyle ver: anahtarın `SAM_` önekli, büyük harfli ve alt çizgili hâli (`budgetPrompt` → `SAM_BUDGET_PROMPT`). Öncelik: ortam değişkeni > `config.json` > varsayılan. Değerlerin türü denetlenir; hatalı bir değer uyarıyla varsayılana döner, `sam doctor` ayar sorunlarını ve bilinmeyen anahtarları listeler.

| Anahtar | Varsayılan | Anlamı |
|---|---|---|
| `budgetSessionStart` | 320 | oturum kartının en fazla token sayısı |
| `budgetPrompt` | 160 | prompt başına hatırlatmanın en fazla token sayısı |
| `maxPromptHits` | 3 | prompt başına en fazla kayıt |
| `minPromptCoverage` | 0.2 | eşik: bir belleğin kapsaması gereken, promptun IDF ağırlığı payı |
| `relPromptFloor` | 0.5 | eşik: en iyi sonucun bu oranının altında kalanları ele |
| `rareConceptShare` | 0.15 | eşik: kanıt bu kadar seçici olmalı (kelimelerinin birlikte eşleştiği belleklerin payı) |
| `gateMinConcepts` / `singleConceptCoverage` | 1 / 0.4 | eşik: kapsanması gereken nadir kavram sayısı / tek başına yeterli kapsam |
| `weakPromptCoverage` | 0.25 | hiçbir sonuç geçmezse en iyi seçici sonuç bu kapsamla yine geçer (0 = kapalı) |
| `absentTermWeight` | 0.7 | bellekte hiç geçmeyen prompt kelimelerinin ağırlığı (1 = daha katı eşik) |
| `gateMode` | `coverage` | `rrf`, v1.1'in skor eşiğine döner (`minPromptScore`, 0.012) |
| `expandQuery` / `expansionWeight` | true / 0.7 | EN/TR eş anlam genişletme, Türkçe gövdeleme, yazım düzeltme ve bunların RRF ağırlığı |
| `decayFloor` | 0.75 | önemli kararlar/kurallar/tercihler bu değerin altına eskimez |
| `globalFactor` | 0.85 | proje içinde genel belleklerin skor çarpanı |
| `cardCoreMax` / `cardGlobalMax` / `cardGistMax` / `cardDiverse` | 14 / 3 / 80 / true | kart: çekirdek satır sayısı, sabitlenmemiş genel satırlar, özet uzunluğu, önce her alandan bir satır |
| `cardGistMaxDurable` | 120 | kural/karar/tercih/prosedür satırlarının özet uzunluğu (cümlecik sınırında kesilir, `kod` ya da bayrak ortasından asla) |
| `specGate` | true | projeye özgülük kapısı: kardeş bir projeyle ya da bu projenin hiç kullanmadığı bir stack'le ilgili promptlara hatırlatma yok |
| `smallStore` / `smallStoreMax` / `smallStoreTokens` | true / 40 / 1500 | en fazla 40 canlı belleği olan proje hepsini deterministik bir döküm olarak alır |
| `nativeDedup` | true | ajanın zaten yüklediği satırları (CLAUDE.md, AGENTS.md, GEMINI.md, kurallar) karttan at; çelişkiyi bir kez belirt |
| `budgetProfile` / `turkishBudgetBoost` | `''` / 1.25 | ajan başına bütçe çarpanı (ör. `claude-4.7`); Türkçe ağırlıklı store'lara ek bütçe |
| `fixPush` / `fixPushMax` / `budgetFix` / `cardFixMax` | true / 2 / 70 / 3 | başarısız bir komuttan sonra eşleşen eski düzeltmeyi gönder (oturum başına, token); karttaki düzeltme satırları |
| `guard` / `agentCapSession` / `agentCapDay` / `reviewAgentRules` / `reviewExpireDays` | true / 6 / 30 / false / 14 | zehirlenme koruması, ajan yazımı sınırları (fazlası onay bekler), inceleme kutusu |
| `sourceTags` / `gateLog` | true / true | `-a`/`-t`/`-i` köken işaretleri; sonraki kalibrasyon için prompt başına eşik özellikleri |
| `redactPII` | true | e-posta, telefon, IBAN ve TCKN'yi kaydetmeden önce maskele |
| `handoff` / `handoffMaxTokens` / `handoffMaxAgeDays` | true / 60 / 14 | ajanlar arası handoff |
| `actr` / `demote` / `sleep` / `skillDrafts` | false | deneysel: ACT-R sıralama çarpanı, arşivlemek yerine alt sıraya düşürme, günlük `sam sleep` birleştirmesi, tekrar eden düzeltmelerden skill taslağı |
| `recentSessions` / `hotFiles` | 2 / 6 | kartta gösterilen son oturum özetleri ve sık düzenlenen dosyalar |
| `embedUrl` / `embedModel` / `embedKey` | kapalı | OpenAI uyumlu herhangi bir `/v1/embeddings` uç noktası (Ollama, LM Studio, OpenAI). Anlamsal bir RRF sinyali ekler; eski kayıtlar için `sam embed`. Yerel olmayan bir URL için `config.json`'da `embedUrl` ya da `"allowRemoteEmbed": true` gerekir |
| `embedInHooks` / `minPromptCosine` | false / 0.6 | embedding'leri hook'larda da kullan (gecikme ekler); eşiği tek başına geçen kosinüs benzerliği |
| `captureDirectives` / `captureCommands` / `captureEdits` / `harvestMarkers` | true | yakalama anahtarları |
| `eventRetentionDays` / `vaultRetentionDays` / `vaultMaxBytes` | 21 / 14 / 2000000 | ham olayların ve kasa çıktılarının saklanma süresi (gün), komut başına en fazla çıktı (bayt) |
| `dbPath` | `~/.sam/sam.db` | veritabanı dosyası |

Ortam değişkenleri: `SAM_HOME` (veritabanı, ayar ve başlatıcı klasörü, varsayılan `~/.sam`; kurulum anındaki değer başlatıcıya yazılır), `SAM_NODE` (başlatıcının kullanacağı Node), `SAM_SHELL` ve `SAM_VAULT_ENCODING` (Windows'ta `sam run`), `SAM_ALLOW_SHARED_FS=1` (ağ ya da eşitlenen klasörde WAL'ı koru), `SAM_PROJECT_DIR` (MCP sunucusunu bir projeye sabitler), `SAM_SESSION`, `SAM_DEBUG=1`. Yalnızca geliştirme için: `SAM_INSTALL_HOME`, `SAM_TEST`, `SAM_SELFTEST`, `SAM_CLAUDE_VERSION`.

### Gizlilik

Her şey kendi makinende kalır. API anahtarları, tokenlar, JWT'ler, özel anahtarlar ve `password=` kalıpları yazılmadan önce maskelenir, kişisel veriler (e-posta, telefon, IBAN, TCKN) de maskelenir (`redactPII`); `<private>…</private>` arasındaki metin hiç kaydedilmez. `sam purge` bir belleği, bir sorgu eşleşmesini ya da bütün bir projeyi her tablodan siler. Kendin bir embedding uç noktası ayarlamadıkça hiçbir veri makineden çıkmaz.

---

## Geliştirme

```bash
npm test                 # 168 test (depolama, arama, erişim, yakalama, kasa, her ajan için hook'lar, MCP, kurulum,
                         #   güvenlik, dayanıklılık/kaos, iş akışı, platform, CLI, şema/gizlilik, koruma, kapı,
                         #   enjeksiyon, paylaşım, entegrasyon); SAM_SLOW=1 uzun kaos koşusunu ekler
npm run bench            # token ölçümü (saf BM25 tabanıyla)
npm run bench:retrieval  # erişim kalitesi ölçümü (embedding ya da Python gerekmez)
npm run bench:v2         # kör EN/TR ölçümü + bilgi güncelleme, zehirlenme, dedup ve gecikme
npm run bench:latency    # prompt başına hook gecikmesi
npm run bench:coding     # belleğin gerektiği kodlama değerlendirmesi (OpenRouter anahtarı gerekir)
npm run e2e              # geçici bir ev dizinine kur ve kurulan her hook komutunu sh ile çalıştır
```

Gereksinim: Node.js 22.16+ (22.x) ya da 24+ (FTS5 destekli yerleşik `node:sqlite`). Katkı için [CONTRIBUTING.md](CONTRIBUTING.md), değişiklikler için [CHANGELOG.md](CHANGELOG.md).

## Teşekkür

SAM, [docs/RESEARCH.md](docs/RESEARCH.md) dosyasındaki projelerin kanıtladığı fikirlerin üzerine kuruldu; özellikle claude-mem (kademeli açılım), context-mode ve openwolf (çıktı yalıtımı), engram (konu anahtarları), agent-memory ve ai-memory (önce sözcüksel arama, bütçeli özetler), ReMe ve OpenViking (tekrar yok), pro-workflow (satır içi öğrenme işaretleri) ve obsidian-mind (azalan bütçeler).

MIT Lisansı.
