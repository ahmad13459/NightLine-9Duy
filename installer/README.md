# نصب‌کنندهٔ NIGHTLINE · Railway

یک اسکریپت که کل مسیر نصب را برایت انجام می‌دهد: توکن Railway می‌گیرد، آخرین نسخهٔ مخزن را می‌آورد، پروژه و سرویس می‌سازد، متغیرها را ست می‌کند، دیپلوی می‌کند و آدرس پنل را چاپ می‌کند.

---

## ۱) توکن Railway از کجا؟

1. وارد <https://railway.com/dashboard> شو.
2. روی آواتار حساب → **Account Settings** → تب **Tokens**.
3. **Create Token** → یک نام بده (مثلاً `nightline`) → **Create**.
4. توکن را کپی کن. (فقط یک بار نشان داده می‌شود.)

> توکن مثل رمز حساب است: در چت و اسکرین‌شات نگذارش. نصب‌کننده آن را فقط در متغیر محیطی همان ترمینال استفاده می‌کند و در هیچ فایلی ذخیره نمی‌کند.

---

## ۲) اجرا

**لینوکس / مک:**

```bash
git clone https://github.com/youdidking/NightLine-Railway
cd NightLine-Railway
bash installer/install.sh
```

**ویندوز (PowerShell + Git Bash یا WSL):** همان دو خط بالا را داخل Git Bash بزن.

**بدون پرسش تعاملی (CI):**

```bash
RAILWAY_TOKEN=xxxx RAILWAY_PROJECT_ID=yyyy bash installer/install.sh
```

پیش‌نیازها: `git`، `node` نسخهٔ ۲۰ یا بالاتر، `curl`. اگر Railway CLI نباشد، خودش با `npm i -g @railway/cli` نصب می‌کند.

### متغیرهای اختیاری

| متغیر | پیش‌فرض | کار |
| :--- | :--- | :--- |
| `RAILWAY_TOKEN` | — | توکن حساب (اجباری) |
| `RAILWAY_PROJECT_ID` | — | اگر پروژه از قبل ساخته‌ای، به همان وصل می‌شود |
| `NIGHTLINE_PROJECT` | `nightline-railway` | نام پروژهٔ تازه |
| `NIGHTLINE_REPO` | مخزن رسمی | آدرس مخزن دیگر |
| `NIGHTLINE_DIR` | `./nightline-railway` | محل کلون |
| `NL_PANEL_PORT` | `8080` | پورت پنل |
| `NL_TCP_PORT` | `8443` | پورت mux که TCP Proxy باید به آن اشاره کند |

---

## ۳) سه کاری که API ریلوی خودش انجام نمی‌دهد

بعد از پایان اسکریپت، یک‌بار در داشبورد پروژه:

1. **دامنهٔ HTTPS** → Settings → Networking → Generate Domain؛ هدف دامنه باید پورت `8080` باشد.
2. **TCP Proxy** → Settings → Networking → TCP Proxy → هدف `8443`.
   بدون این، REALITY / Shadowsocks / AnyTLS / MTProto بالا نمی‌آیند.
3. **Volume** → Settings → Volumes → Mount روی `/data`.
   بدون این، کاربران و کلیدها با هر دیپلوی از بین می‌روند.

بعد همان آدرس را باز کن؛ فرم ساخت حساب مدیر می‌آید و از آنجا با تب **تنظیم آسان** لینک آماده را بردار.

---

## ۴) اگر جایی گیر کرد

| نشانه | علت | راه‌حل |
| :--- | :--- | :--- |
| `توکن پذیرفته نشد` | توکن پروژه‌ای است نه حسابی | از Account Settings → Tokens توکن حساب بساز |
| پنل باز نمی‌شود | دامنه به پورت دیگری وصل است | هدف دامنه را `8080` کن |
| همهٔ لینک‌ها پینگ منفی | TCP Proxy نداری | TCP Proxy روی `8443` بساز |
| با هر دیپلوی کاربران می‌پرند | Volume نداری | Volume روی `/data` |
| `railway init` خطا داد | پروژهٔ قبلی در پوشه است | `railway link` بزن یا `RAILWAY_PROJECT_ID` بده |

راه دیگر (بدون اسکریپت): مخزن را در گیت‌هاب خودت Fork کن و در Railway با **Deploy from GitHub repo** بساز — راهنمای گام‌به‌گام در [README اصلی](../README.md#نصب-روی-railway-پنج-گام) هست.

---

NIGHTLINE · Railway — رایگان و غیرقابل فروش · <https://github.com/youdidking/NightLine-Railway>
