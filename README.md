# Territory (working title)

A territory-control strategy game in your browser. Start from a small patch of land, send troops to claim more,
and outgrow ten rival nations on a generated continent. Plain HTML and JavaScript on a canvas, no build step,
no dependencies.

## Play

Download the repo and open `index.html` in a browser.

## How it works

- **Troops** grow over time, but only up to your **cap**, which rises with the land you hold. Growth is fastest
  around 40% of your cap (the tick on the troop bar) and stops at the cap, so sitting full wastes time.
- **Click** open land or a neighbour's land to send the chosen share of your troops (**1** to **4**, or the buttons
  at the bottom). An attack spreads along your shared border until its troops run out.
- Open plains are cheapest. Forest, hills and mountains cost more per tile, and land someone already owns costs more
  the more troops they hold per tile.
- **Space** pauses. 1x, 2x and 4x change the speed.

You win by holding 80% of the land or outlasting every rival.

## License

MIT, see [LICENSE](LICENSE).
