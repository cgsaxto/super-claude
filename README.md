# Super Claude

An open-source pixel platform adventure with three levels and original synthesized sound effects. Built with Canvas 2D and Web Audio, with no runtime dependencies, external assets, backend, or API keys.

Guide Clawd through a nighttime forest, dodge rocks and meteors, stomp patrollers, collect every Spark, and reach the beacon.

## Run locally

```sh
python3 -m http.server 8000
```

Open [localhost:8000](http://localhost:8000/). A desktop browser and keyboard are required. Touch controls are not implemented.

## Controls

| Action | Controls |
| --- | --- |
| Move | A / D or Left / Right Arrow |
| Jump | Space, W, or Up Arrow; tap for a short jump, hold for a full jump |
| Pause / resume | Esc or P; switching tabs automatically pauses the game |
| Toggle sound | M or the speaker button in the top right corner |
| Adjust volume | Slider in the top right corner |
| Start / activate the primary panel action | Enter or click the button |

## Gameplay

- Three levels: Forest Trail, Falling Stars, and Before Dawn, with 8, 10, and 12 required Sparks.
- Collect every Spark in the current level to unlock its beacon, then reach the beacon to finish the level.
- Start with three lives. Rocks, enemy side collisions, and meteor impacts cause damage, followed by brief invulnerability.
- Land on a patroller from above to defeat it and bounce upward.
- Meteors display a warning before falling. Damage is checked once at impact; move out of range or jump high enough to avoid it.
- Embers increase your score, Hearts restore health, and Shields block one hit. Shields do not protect against falling into gaps.
- Each level has two checkpoints. Falling into a gap costs a life and respawns the player; collected items stay collected.
- Retry level restarts the current level while preserving previous level results. Restart adventure starts over.
- Transition panels have a short input guard to prevent accidental actions. Play time excludes pauses and panel waits.

## Original sound effects

`audio.js` synthesizes effects using square waves, triangle waves, original note patterns, and filtered noise. It contains no external samples or background music. Audio starts only after a user interaction, and the game remains playable if audio is unavailable. Volume and mute preferences are stored locally in localStorage.

## Development and verification

Node.js 20 or newer is required for development commands. There are no npm package dependencies.

```sh
npm run check
npm test
npm run build
```

The build copies only the five runtime game files into `public/`; tests, documentation, and local temporary files are excluded from the deployed site. Tests cover Spark counts, rock exclusion zones, rock spacing, and seed reproducibility across 200 seeds per level. These checks do not replace human playtesting or complete browser walkthroughs.

## Deploy to Vercel

Import this GitHub repository into Vercel and select the Other preset. `vercel.json` configures `npm run build` and the `public` output directory. No environment variables are required.

## Configuration and files

- `levels.js`: physics and difficulty settings in `TUNING`, terrain segments, three levels, rocks, and meteor schedules.
- `game.js`: input, state, physics, collisions, enemies, collectibles, camera, and rendering.
- `audio.js`: sound synthesis and audio settings.
- `index.html` / `style.css`: interface and responsive game stage.
- `scripts/build.mjs`: static production build.
- `tests/levels.test.cjs`: level invariant tests.

Use `?seed=14` to reproduce a level layout and `?level=2` to start at the second level. The level parameter accepts only integers from 1 to 3; invalid values fall back to the first level.

`superClaude.state()` and `superClaude.snapshot()` provide read-only debug information. The earlier name `clawdsQuest` remains as a compatibility alias.

## Known limitations

Verification has focused on desktop Chrome in a macOS browser environment. Firefox, other operating systems, and touch devices have not been fully verified. The project owner has manually played through the game successfully. All three levels share the forest setting, and there is one patroller type.

## License

[MIT](LICENSE). This is an independent community game and is not affiliated with or endorsed by Anthropic.
