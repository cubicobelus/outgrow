# Territory (working title)

A territory-control strategy game in your browser. Start from a small patch of land, send troops to claim more,
and outgrow ten rival bots on a generated continent. Plain HTML and JavaScript on a canvas, no build step,
no dependencies.

## Play

**[Play in your browser](https://cubicobelus.github.io/territory-game/)**: nothing to download or install.

To run it offline, download the repo and open `index.html` in a browser.

## How it works

- **Troops** grow over time, but only up to your **cap**, which rises with the land you hold. Growth is fastest
  around 40% of your cap (the tick on the troop bar) and stops at the cap, so sitting full wastes time.
- **Click** open land or a neighbour's land to send the chosen share of your troops (**1** to **5**, or the buttons
  at the bottom). An attack spreads along your shared border until its troops run out; its troops show on the map.
- **Boats:** click land you can only reach across water to send your troops by boat. Up to 3 at sea at once.
- Open plains are cheapest and fastest. Forest, hills and mountains cost more, slow attacks down and help defenders.
  Open land next to a rival costs extra, and land someone owns costs more the more troops they hold per tile.
- **Scroll** or pinch to zoom and drag to move the map. **Space** pauses, **Esc** opens the menu. 1x, 2x and 4x change the speed.
- From the main menu you pick how many bots of each level to face (up to 15) and a 10, 15 or 20 minute match.

You win by holding 80% of the land or outlasting every rival. Otherwise, when the clock runs out,
whoever holds the most land wins.

Each match opens with an 8 second starting window: click to place your start (click again to move it) while
the bots drop in theirs. Starts must be at least 14 tiles apart.

The ten rivals come in four levels: **Easy**, **Medium**, **Hard** and **Expert**. They all play by the same rules
as you. Easy and Medium make classic mistakes; Hard and Expert grab land fast and only attack when it pays.

## License

MIT, see [LICENSE](LICENSE).
