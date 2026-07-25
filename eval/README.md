# Prompt eval

A tiny harness to eyeball prompt quality across changes. It runs a golden set of
sample posts through the **real shipping engine** (`src/engine.js` + the prompts
in `src/shared.js`), shows the verdict/topics/rewrite for each, and exports a CSV
you can rate by hand.

Because My Little LinkedIn runs on Chrome's on-device Prompt API (Gemini Nano),
the eval must run **inside a real, flags-enabled Chrome renderer** — there's no
Node binding, and `file://` origins can't reach the API. So serve it over
`http://localhost`:

```sh
# from the repo root
python3 -m http.server 8000
```

Then open **http://localhost:8000/eval/eval.html** in a Chrome that has the
built-in AI flags enabled and the model downloaded (see the repo README's
install steps). Pick a transform, optionally set care/avoid topics, and click
**Run eval**. Rate each row and **Export CSV**.

## Iterating

1. Edit a prompt in `src/shared.js` (transform presets) or `src/engine.js`
   (classify/analyze system prompts, guardrail).
2. Reload the page, **Run eval** again.
3. Compare against your previous CSV.

## The golden set

`golden-set.js` holds the cases (`window.MLL_GOLDEN`). Each has `text`, an
optional `author` (exercises the name-extraction path), and a `note` describing
what it probes. It deliberately includes:

- fluff at several levels (PURE → LOW),
- a Hebrew post (must be rewritten *in Hebrew*),
- French and Spanish posts (must be rewritten in their own language, not
  translated to English),
- a layoff post (the tone guardrail must keep it kind).

Add real posts you want to regression-test by appending to that array.

## See also

`../demo/anim-test.html` — a standalone sandbox (no model, no extension load)
for tuning the cross-fade animation in `reveal()`.
