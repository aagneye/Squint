# Squint

**Does your vision AI know when it can't read the label?**

Squint is a crash-test lab for AI that reads medicine and food labels aloud for blind and
low-vision people. It renders labels with exactly known text, degrades them step by step
(blur, low light, tilt, glare, occlusion), asks the model the questions a blind user asks,
and finds the point where reading turns into guessing. Then it ships the fix and measures it.

A blurry photo of a 40 mg bottle must produce "I can't read this, please retake",
never a confident "10 mg".

Built for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026) on the Meta Model API.

## Status

Work in progress. See `docs/superpowers/specs/` for the design.

## Requirements

- Node 22 or newer (no npm dependencies)
- Windows PowerShell 5.1 (label rendering uses the built-in System.Drawing)
- ffmpeg on PATH (image degradation)
- A Meta Model API key in `MODEL_API_KEY` for real runs; everything else works offline

## Run

```powershell
npm test                       # offline tests
node src/cli.mjs --help
```

## Safety note

Everything Squint renders is synthetic: fake pharmacies, fake patients, fake lot numbers.
Squint tests whether an AI can read a label. It gives no medical advice.
