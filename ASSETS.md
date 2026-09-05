# Asset provenance and licensing

The code in this repository is original and MIT-licensed (see [LICENSE](LICENSE)).
**The media files under `public/assets/` are not.** This file records where they
came from and what may be done with them.

## What is in here

| Path | What it is | Origin |
| --- | --- | --- |
| `public/assets/character/<id>.png` | Head cutout of a public figure | Photographs of real people, cut out with the in-repo cutout tool |
| `public/assets/audio/<id>/music.mp3` | That character's background music | Clips taken from YouTube videos |
| `public/assets/audio/<id>/gameover.mp3` | That character's lose sound | Short clips from films / YouTube / meme audio |
| `public/assets/audio/*.mp3` | Flap, point, collision, fanfare | Shared UI sounds |
| `public/assets/character/character-placeholder.svg` | Fallback artwork | Original to this project, MIT |

## Licensing status

These files were assembled for a single university tech-fest stall — a
non-commercial, one-off event — and were never cleared for redistribution.
They remain the property of their respective rights holders:

- the **photographs** are owned by whoever shot them, and the people depicted
  have their own personality/publicity rights
- the **music and film clips** are owned by their labels, studios and artists

Nothing here is licensed for reuse. If you fork this project, **replace the
contents of `public/assets/` with material you own or are licensed to use.**
The game is built to make that easy: every path is declared in
`public/src/assets/manifest.js`, and any missing file degrades gracefully (a
missing image falls back to the drawn pixel bird, a missing sound to a synth
voice, missing music to silence). The game is fully playable with
`public/assets/` emptied out.

## Removing the bundled media

To keep the code but drop the third-party media from a checkout:

```bash
git rm -r --cached public/assets/audio public/assets/character
printf 'public/assets/audio/**/*.mp3\npublic/assets/character/*.png\n' >> .gitignore
git commit -m "Remove bundled third-party media"
```

Note that this removes them from future commits only — they remain in the git
history until the history itself is rewritten (`git filter-repo` or similar).

## Attribution

If you are reading this because you own something in here and would rather it
were not published, open an issue on the repository and it will be removed.
