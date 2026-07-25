<p align="center">
  <img src="icons/logo512.png" width="120" alt="My Little LinkedIn logo" />
</p>

<h1 align="center">My Little LinkedIn</h1>

<p align="center">
  <em>Your feed, your rules — rewrite every post, tag what you care about, and get a relevance verdict on each one. 100% on-device. No account, no API key, no backend.</em>
</p>

---

## The story

It started with [**Defluffer**](https://chromewebstore.google.com/detail/defluffer/ofaajilnnjfcinocgpljpmchpcnbhhln) — a lovely little extension that trims long, AI-fluffed LinkedIn posts down to one honest line as you scroll. I loved the idea and wanted my own variation of it.

So I did what any curious person does: I read its source. And I found the twist — Defluffer isn't magic on your machine. It ships the post text to a Cloudflare Worker that calls Gemini Flash-Lite server-side (the API key lives on their server, which is why *you* don't need one). Clever and clean — but it means running a backend.

That's when I realized I could try the thing every one of us now has sitting in Chrome anyway: the **built-in Prompt API backed by Gemini Nano** — a real LLM that runs *locally, in the browser*. No server to deploy, no key to rotate, no bill to pay, and nothing about your feed ever leaves your machine.

So I built **My Little LinkedIn**: not just a defluffer, but a general lens for your feed — swap the transform (defluff, pirate, corporate, or your own), tag the topics you care about, and get a per-post verdict — all powered by the on-device model.

## What it does

- **Transform every post** — pick a style and the post body is rewritten in place as you scroll, with a *show original* toggle:
  - Defluff (one honest line) · Pirate · Fluff it up · Plain summary · Gen-Z · Shakespeare · Corporate buzzwords
  - …or write your **own** custom transform.
- **Relevance verdict** — each post gets topic tags plus a **Relevant / Neutral / Muted** chip. Muted posts (topics you'd rather avoid) are gently dimmed.
- **👍 / 👎 the tags** — thumb a topic up to add it to *care*, down to add it to *avoid*. It's saved and reshapes every future post. A post that hits both a liked and a disliked topic cancels out to Neutral.
- **English & Hebrew** — the UI is English, but each post is rewritten in **its own language**. A Hebrew post gets a Hebrew pirate, not an English one.
- **Fast & polite** — work is gated to what you're seeing or about to see, and **cancelled the moment you scroll past**; a small spinner shows what's computing right now.

## How it works

Everything runs through Chrome's built-in `LanguageModel` (Prompt API / Gemini Nano):

- The rewritten line **copies the post's own computed typography** and cross-fades in, so it reads as native LinkedIn text (a trick borrowed from Defluffer).
- When both a verdict and a rewrite are needed, they're produced in **one** structured model call.
- Results are **cached** by post text so LinkedIn's feed recycling never recomputes.
- An `IntersectionObserver` + `AbortController` per post means off-screen posts never burn compute.

No network requests. No analytics. The only thing stored is your settings (topics + transforms), in Chrome's own sync storage.

## Install (developer mode)

> **Not on the Chrome Web Store yet.** If there's enough demand, I'll happily pay the $5 developer fee and publish it there. For now, load it unpacked — it takes a minute.

This uses Chrome's built-in AI, which is still gated behind flags today:

1. Use **Chrome 138+**.
2. At `chrome://flags`, set:
   - `#prompt-api-for-gemini-nano` → **Enabled**
   - `#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
3. Restart Chrome. The model downloads once (~2 GB) on first use.
4. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
5. Open your LinkedIn feed. If the model isn't ready you'll get an honest little "on-device AI unavailable" note instead of silent nothing.

## Privacy

Your posts never leave your browser — there is no server. The extension only touches `linkedin.com`, stores only your own settings, and collects nothing.

## Credits

Inspired by [Defluffer](https://chromewebstore.google.com/detail/defluffer/ofaajilnnjfcinocgpljpmchpcnbhhln) — thank you for the spark. Rebuilt from scratch on-device, and generalized into a whole feed lens.
