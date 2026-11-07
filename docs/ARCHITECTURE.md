<div dir="rtl" align="right">

# معماری

## نقشهٔ کلی

```
                 ┌──────────────────────────── Railway edge (TLS) ───────────────────────────┐
client ── https ──┤ :443                                                                          │
                 └───────────────┬───────────────────────────────────────────────────────────────┘
                                 ▼
                        ┌────────────────────┐
                        │  Node panel :8080  │
                        │  src/http/server.js│
                        └───┬─────┬─────┬────┘
             /api /sub /u   │     │     │  /nl-<routeKey>
                            │     │     └────────► reverse proxy ──► Xray / sing-box inbound
                            │     └──► JSON API / subscription      (127.0.0.1:11xxx)
                            └──► UI (public/)

client ── tcp ──┐
                ▼
   Railway TCP Proxy (one public port)
                ▼
   ┌──────────────────────────┐
   │ Multiplexer :8443        │  src/proxy/mux.js
   │  classify(first bytes)   │  src/proxy/sni.js
   └───┬───────┬───────┬──────┴────────┐
       │TLS    │0x05   │HTTP           │other
       ▼       ▼       ▼               ▼
   SNI map   SOCKS5   HTTP/CONNECT   MTProto (mtg)
   REALITY   server   proxy          FakeTLS / obfuscated2
   AnyTLS
   ShadowTLS
   FakeTLS(mtg)
```

## چرخهٔ تغییر تنظیمات

```
UI action ──► POST /api/... ──► store.set()  (JSON اتمیک در Volume)
                                   │
                                   ▼
                          runtime.apply()
                            ├─ buildXrayConfig()   → xray -test   → restart
                            ├─ buildSingboxConfig()→ sing-box check→ restart
                            └─ mtproto.start()     → mtg simple-run
```

- هر تغییر فقط همین چرخه را طی می‌کند؛ هیچ وضعیت دیگری در حافظه نگه‌داری نمی‌شود.
- اگر کانفیگ تولیدشده از تست هسته رد نشود، **هستهٔ قبلی دست‌نخورده می‌ماند** و پیام خطا در UI نمایش داده می‌شود.

## شمارش ترافیک

```
Xray StatsService (gRPC over h2c, 127.0.0.1:10085)
        │  هر ۲۰ ثانیه: QueryStats(pattern="")
        ▼
TrafficAccountant.ingest()  → دلتای هر شمارنده (تحمل ریست روی ری‌استارت)
        ▼
user.usage.up/down += delta      +  یک نمونه برای نمودار ترافیک
        ▼
enforceQuotas()  → کاربر بیش از سهمیه/منقضی از کانفیگ‌ها حذف می‌شود
```

پیاده‌سازی gRPC و protobuf بدون وابستگی: [`src/stats.js`](../src/stats.js).

## تصمیم‌های طراحی

| تصمیم | دلیل |
| :--- | :--- |
| JSON تک‌فایلی به‌جای دیتابیس | ریلوی رایگان فقط ۰٫۵ گیگ Volume دارد؛ JSON اتمیک کافی و قابل پشتیبان‌گیری است |
| مالتی‌پلکسر تک‌پورت | ریلوی یک TCP Proxy می‌دهد؛ این تنها راه سرو هم‌زمان REALITY + پروکسی تلگرام است |
| reverse-proxy مسیر برای WS/XHTTP | دو هسته نمی‌توانند روی یک پورت عمومی گوش کنند؛ Node می‌تواند هم‌زمان به هر دو مسیر بدهد |
| اعتبارسنجی قبل از ری‌استارت | جلوگیری از خطای انسانی که سرویس را می‌خواباند |
| لینک‌سازی مبتنی بر «connection descriptor» | یک تابع برای هر پروتکل، ورودی یکسان برای HTTP-edge و TCP-edge |
| mtg به‌جای پیاده‌سازی MTProto | نگه‌داری و امنیت پروتکل MTProto+FakeTLS کار ساده‌ای نیست؛ mtg آزمون‌شده است |

## نقاط توسعه

- افزودن پروتکل جدید: یک آیتم در `PRESETS` ([`src/catalog.js`](../src/catalog.js)) + شاخه‌ای در `buildXrayConfig` یا `buildSingboxConfig` + شاخه‌ای در `toUri` و `singboxOutbound`/`clashYaml`.
- افزودن هستهٔ سوم: کلاس `Core` را نمونه‌سازی کنید، سوپروایزر عمومی است.
- مالتی‌نود: می‌توان `edge` جدیدی تعریف کرد که لینک‌ها را به یک سرور دیگر اشاره دهد؛ ساختار connection descriptor آمادهٔ این کار است.

</div>
