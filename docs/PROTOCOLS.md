<div dir="rtl" align="right">

# پروتکل‌ها و دستور پخت‌ها

فهرست کامل در [`src/catalog.js`](../src/catalog.js) تعریف شده است. هر «دستور پخت» می‌گوید:

- `core`: کدام هسته اجرا می‌کند (`xray` یا `singbox`).
- `transport`: لایهٔ انتقال (`tcp`، `ws`، `httpupgrade`، `xhttp`، `grpc`، `quic`).
- `security`: `none`، `tls-edge` (TLS را ریلوی تمام می‌کند)، `tls-self` (گواهی خودامضا) یا `reality`.
- `tier`: `verified` (روی پورت TCP ریلوی تست شده و پیش‌فرض روشن است) یا `lab` (نگه‌داشته شده برای دامنهٔ اختصاصی؛ پیش‌فرض خاموش). فهرست کوتاه در [README](../README.md#کدام-کانفیگ-روی-railway-واقعاً-کار-میکند).
- `edge`: مسیر رسیدن کلاینت:
  - `http` → از پورت ۴۴۳ عمومی و دامنهٔ HTTPS ریلوی؛ پنل با پیشوند مسیر `/<routeKey>` به هستهٔ مربوطه reverse-proxy می‌کند.
  - `tcp` → از تنها پورت TCP Proxy؛ مالتی‌پلکسر با SNI یا نوع دست‌دادن تصمیم می‌گیرد.
- `udp`: اگر `true` باشد، سرویس روی ریلوی قابل انتشار نیست.

## ماتریس کامل

| id | عنوان | هسته | ترانسپورت | امنیت | edge | روی Railway |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `vless-ws` | VLESS + WebSocket | xray | ws | tls-edge | http | ✅ |
| `vless-httpupgrade` | VLESS + HTTPUpgrade | xray | httpupgrade | tls-edge | http | ✅ |
| `vless-xhttp` | VLESS + XHTTP | xray | xhttp | tls-edge | http | ✅ |
| `vless-grpc` | VLESS + gRPC | xray | grpc | tls-edge | http | ⚠️ |
| `vmess-ws` | VMess + WS | xray | ws | tls-edge | http | ✅ |
| `vmess-grpc` | VMess + gRPC | xray | grpc | tls-edge | http | ⚠️ |
| `trojan-ws` | Trojan + WS | xray | ws | tls-edge | http | ✅ |
| `trojan-grpc` | Trojan + gRPC | xray | grpc | tls-edge | http | ⚠️ |
| `vless-reality` | VLESS + REALITY (Vision) | xray | tcp | reality | tcp | ✅ |
| `vless-tcp` | VLESS خام | xray | tcp | none | tcp | ✅ |
| `vmess-tcp` | VMess خام | xray | tcp | none | tcp | ✅ |
| `trojan-tcp-tls` | Trojan + TLS خودامضا | xray | tcp | tls-self | tcp | ✅ |
| `ss-2022` | Shadowsocks 2022 | xray | tcp | none | tcp | ✅ |
| `ss-legacy` | Shadowsocks AEAD | xray | tcp | none | tcp | ✅ |
| `sb-vless-ws` | VLESS + WS | singbox | ws | tls-edge | http | ✅ |
| `sb-trojan-ws` | Trojan + WS | singbox | ws | tls-edge | http | ✅ |
| `sb-vmess-ws` | VMess + WS | singbox | ws | tls-edge | http | ✅ |
| `anytls` | AnyTLS | singbox | tcp | tls-self | tcp | ✅ |
| `shadowtls` | ShadowTLS v3 | singbox | tcp | tls-self | tcp | ✅ |
| `sb-ss-2022` | Shadowsocks 2022 | singbox | tcp | none | tcp | ✅ |
| `sb-vless-reality` | VLESS + REALITY | singbox | tcp | reality | tcp | ✅ |
| `hysteria2` | Hysteria2 | singbox | quic | tls-self | udp | ❌ |
| `tuic` | TUIC v5 | singbox | quic | tls-self | udp | ❌ |
| `wireguard` | WireGuard | singbox | udp | none | udp | ❌ |

## پارامترهای پرکاربرد

| کلید | توضیح | پیش‌فرض |
| :--- | :--- | :--- |
| `path` | پسوند مسیر HTTP. پیشوند `/<routeKey>` خودکار اضافه می‌شود | `/` |
| `host` | مقدار هدر Host (برای CDN/فرانتینگ) | خالی = دامنهٔ خودتان |
| `serviceName` | نام سرویس gRPC؛ به‌شکل `<routeKey>/<serviceName>` استفاده می‌شود | `grpc...` |
| `dest` | مقصد REALITY به‌شکل `host:port` (باید TLS 1.3 و HTTP/2 داشته باشد) | `www.cloudflare.com:443` |
| `shortIds` | فهرست shortId با کاما؛ فقط هگز با طول زوج | `a1b2c3d4,...` |
| `flow` | `xtls-rprx-vision` برای REALITY | روشن |
| `method` | متد Shadowsocks | `2022-blake3-aes-128-gcm` |

## نکته‌های REALITY

- جفت‌کلید X25519 در اولین اجرا در `state/reality.json` (داخل Volume) ساخته می‌شود و در UI فقط کلید عمومی/`pbk` در لینک ظاهر می‌شود.
- `dest` باید سایتی باشد که واقعاً TLS 1.3 بدهد و به `h2` پاسخ دهد.
- کلاینت باید `fp=chrome` و `sni` برابر دامنهٔ `dest` داشته باشد؛ پنل همین را در لینک می‌گذارد.
- چند اینباند REALITY هم‌زمان مجاز است؛ مسیریابی با SNI انجام می‌شود، پس SNI هر اینباند باید یکتا باشد.

## نکته‌های Shadowsocks 2022

- در حالت چندکاربره، کلید سرور از سکرت نصب مشتق می‌شود و هر کاربر کلید جداگانه دارد؛ لینک کلاینت به‌شکل `method:serverKey:userKey` ساخته می‌شود.
- برای متدهای قدیمی (AEAD)، SS فقط یک رمز مشترک دارد و در پنل با نام «shared» علامت می‌خورد.

## نکته‌های gRPC

gRPC نیاز به HTTP/2 سرتاسری دارد. پنل، مسیر `/nl-<id>/<service>` را به هسته forward می‌کند، اما اگر لبهٔ ریلوی اتصال را به HTTP/1.1 تبدیل کند، gRPC کار نمی‌کند. برای اطمینان از WS یا XHTTP استفاده کنید.

</div>
