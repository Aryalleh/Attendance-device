# Android door app (phone = door device)

**English** · [فارسی](#راهنمای-فارسی)

This app turns an Android phone with NFC into a door device. It replaces the Wemos + RC522:

- the phone's **NFC antenna reads the cards** (13.56 MHz: MIFARE, NTAG, etc.; the card UID is used, as on the RC522),
- it talks to the server through the **same device API** as the firmware (`/api/v1/scan`, `/sync`, with `X-Device-Key`),
- its screen **opens the door's live screen (kiosk) automatically** and stays on it: full screen, screen always on,
  started at boot, registered as a Home app, and locked to the app (Android lock-task),
- it is **online only**: every card is decided by the server. The phone stores no card list and no offline log.
  If the server can't be reached, the scan is refused and the screen says "server unreachable".

```
 card ─► phone NFC ─► Door Kiosk app ──Wi-Fi──► server (Flask or Cloudflare)
                       └ full-screen live screen of this door (/kiosk/<token>)
```

On the server, the phone is just another door: it shows as online, has its own direction (entry/exit/toggle),
and you can disable it or give it a new key. A phone has no relay, so **Open** from the panel only shows
"door opened remotely" on the screen.

## Install

1. Download the APK: https://github.com/Aryalleh/Attendance-device/releases/latest/download/door-kiosk.apk
   (every build of `main` is published under **Releases**).
   You can also build it with Android Studio, or run `./gradlew assembleRelease` in `android/` (needs the Android SDK).
2. Copy the APK to the phone and install it. Allow "install unknown apps" if Android asks.
3. On the server, open **Doors → New door** and copy the key.
4. Open the app and enter:
   - **Server address**: e.g. `http://192.168.1.10:8080` (Flask), or `https://accessctl.<you>.workers.dev`,
   - **Door key**: the key from step 3,
   - **Admin PIN**: needed to leave the kiosk screen (strongly recommended).
5. Tap **Save and start**. The app checks the key with the server and switches to the kiosk screen.

The server needs this version or newer: the app calls `GET /api/v1/kiosk` to get the door's live-screen link.

## Kiosk mode

| | Normal install | Device owner (recommended for a phone mounted by a door) |
|---|---|---|
| Opens at boot | yes, if you choose the app as **Home** app (Android asks when you press Home) | yes, automatically |
| Locked to the app | Android asks once "pin this app?" | yes, no prompt; Home/Recents do nothing |
| Status bar / lock screen | still there | disabled |
| Screen on while charging | keep-screen-on while the app is open | yes, also set system-wide |

**Device owner setup** (once, on a phone with **no Google account** on it, e.g. right after a factory reset):

```sh
adb install door-kiosk.apk
adb shell dpm set-device-owner com.accessctl.door/.AdminReceiver
```

Then open the app once and set it up. Keep the phone on a USB charger.

**Leaving the kiosk screen:** tap the **top-right corner 5 times** quickly and enter the admin PIN. The settings screen opens.
From there, **Exit kiosk mode** returns the phone to its normal launcher until you open the app again.
**Remove device owner** is needed before you can uninstall the app.

## Notes

- Hold a card flat against the back of the phone, near the NFC antenna (usually the middle or upper half).
- The same card is ignored for 2 s after a scan, as on the Wemos.
- `http://` servers on the LAN are allowed (cleartext traffic is enabled for this).
- Sounds: the live page plays its own chime. The phone also beeps when it reads a card and vibrates on a refusal.
- There is no standalone or offline mode on the phone: keep it on reliable Wi-Fi. A refused scan while the server is
  down is not logged.

---

<div dir="rtl">

## راهنمای فارسی

این برنامه یک گوشی اندرویدی دارای NFC را به **دستگاه در** تبدیل می‌کند، به جای Wemos و RC522:

- **آنتن NFC گوشی کارت را می‌خواند** (۱۳٫۵۶ مگاهرتز؛ شناسهٔ کارت مثل RC522 استفاده می‌شود)،
- با **همان API دستگاه** با سرور صحبت می‌کند (`/api/v1/scan` و `/sync` با هدر `X-Device-Key`)،
- صفحهٔ گوشی **به‌طور خودکار نمایشگر زندهٔ همین در (کیوسک)** را باز می‌کند و روی آن می‌ماند: تمام‌صفحه، صفحه همیشه روشن،
  اجرا پس از روشن شدن گوشی، ثبت به‌عنوان برنامهٔ Home و قفل روی برنامه،
- **فقط آنلاین** کار می‌کند: همهٔ کارت‌ها را سرور بررسی می‌کند و گوشی هیچ لیست کارت یا گزارش آفلاینی نگه نمی‌دارد.
  اگر سرور در دسترس نباشد، کارت رد می‌شود و روی صفحه «سرور در دسترس نیست» نمایش داده می‌شود.

### نصب

1. دانلود APK: https://github.com/Aryalleh/Attendance-device/releases/latest/download/door-kiosk.apk
   (هر ساخت از شاخهٔ `main` در بخش **Releases** منتشر می‌شود).
2. APK را روی گوشی نصب کنید.
3. در پنل سرور **درها ← در جدید** را بزنید و کلید را کپی کنید.
4. برنامه را باز کنید و **آدرس سرور**، **کلید در** و **رمز مدیر** را وارد کنید و **ذخیره و شروع** را بزنید.

### حالت کیوسک کامل (پیشنهادی)

یک بار، روی گوشی **بدون حساب گوگل** (مثلاً بلافاصله پس از ریست کارخانه):

```sh
adb install door-kiosk.apk
adb shell dpm set-device-owner com.accessctl.door/.AdminReceiver
```

پس از این کار گوشی هنگام روشن شدن مستقیم وارد نمایشگر می‌شود، دکمه‌های Home و Recents کار نمی‌کنند و نوار وضعیت و قفل صفحه غیرفعال می‌شوند.
بدون این مرحله، برنامه را به‌عنوان **Home** پیش‌فرض انتخاب کنید و پیام «سنجاق کردن برنامه» را تأیید کنید.

**خروج از نمایشگر:** گوشهٔ **بالا-راست** صفحه را ۵ بار پشت سر هم لمس کنید و رمز مدیر را وارد کنید.
گزینهٔ **خروج از حالت نمایشگر** گوشی را به حالت عادی برمی‌گرداند. پیش از حذف برنامه، **حذف «مالک دستگاه»** را بزنید.

</div>
