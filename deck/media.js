import { renderToString } from "react-dom/server";
import { createElement } from "react";
import htm from "htm";

const html = htm.bind(createElement);

// Single source of truth for logos using htm
export const logosHtm = {
  nearform: html`<img
    src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTODiKxPSWQzaep57CVW9j3x3n4iIlZkZLOZA&s"
    style=${{ width: "0.9em", height: "0.9em", marginBottom: "-0.05em" }}
  />`,
  mofo: html`<img
    src="./images/mofo-icon.png"
    style=${{
      width: "0.8em",
      height: "0.8em",
      marginBottom: "-0.05em",
      backgroundColor: "#fff",
      border: "5px solid #fff",
    }}
  />`,
  js: html`<img
    src="https://events.linuxfoundation.org/wp-content/uploads/2024/11/js_logo_white-1.svg"
    style=${{
      width: "0.9em",
      height: "0.9em",
      marginBottom: "-0.05em",
      marginRight: "0.2em",
    }}
  />`,
};

// Convert htm components to raw HTML strings using React's renderToString
export const logos = Object.fromEntries(
  Object.entries(logosHtm).map(([key, component]) => [
    key,
    renderToString(component).replace(/\n/g, ""),
  ]),
);

export const images = {
  // Relative to index.html
  qrCode: "./images/qr-code-ai-vs-law-square.svg",
  spectacle: "./images/spectacle-banner.png",
  mofo: "https://www.mofo.com/_ipx/w_384,q_75/https%3A%2F%2Fmedia2.mofo.com%2Fv3%2Fimages%2Fblt5775cc69c999c255%2Fblt52856f2e1a73609c%2Fmofo-logo-2022.svg%3Fformat%3Dauto%26quality%3D60?url=https%3A%2F%2Fmedia2.mofo.com%2Fv3%2Fimages%2Fblt5775cc69c999c255%2Fblt52856f2e1a73609c%2Fmofo-logo-2022.svg%3Fformat%3Dauto%26quality%3D60&w=384&q=75",
};

const UNSPLASH_QUERY = "q=80&w=1024&auto=format&fit=crop";

export const backgrounds = {
  // Current
  chesapeakeBay: `https://assets.hyatt.com/content/dam/hyatt/hyattdam/images/2017/09/12/1134/Hyatt-Regency-Chesapeake-Bay-Golf-Resort-Spa-and-Marina-P210-Resort-at-Sunset.jpg/Hyatt-Regency-Chesapeake-Bay-Golf-Resort-Spa-and-Marina-P210-Resort-at-Sunset.16x9.jpg?imwidth=1920`,
  usSupremeCourt: `https://images.unsplash.com/photo-1453945619913-79ec89a82c51?${UNSPLASH_QUERY}`,
  gavelBook: `https://images.unsplash.com/photo-1618771623063-6c3faa854a61?${UNSPLASH_QUERY}`,
  bookStacks: `https://images.unsplash.com/photo-1550399105-c4db5fb85c18?${UNSPLASH_QUERY}`,
  greenCode: `https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?${UNSPLASH_QUERY}`,
  typing: `https://images.unsplash.com/photo-1560092269-eaeb3c5e74ba?${UNSPLASH_QUERY}`,
  mopop: `https://images.unsplash.com/photo-1508858648555-ba5da0be9511?${UNSPLASH_QUERY}`,
  cuttingBoard: `https://images.unsplash.com/photo-1690983321709-0eccbcb20d00?${UNSPLASH_QUERY}`,
  networkCables: `https://images.unsplash.com/photo-1558494949-ef010cbdcc31?${UNSPLASH_QUERY}`,
  postits: `https://images.unsplash.com/photo-1507925921958-8a62f3d1a50d?${UNSPLASH_QUERY}`,
  notebook: `https://images.unsplash.com/photo-1598620616655-7fce1a6fdf87?${UNSPLASH_QUERY}`,
  fire2: `https://images.unsplash.com/photo-1517594422361-5eeb8ae275a9?${UNSPLASH_QUERY}`,
  danger: `https://images.unsplash.com/photo-1587065915399-8f8c714ab540?${UNSPLASH_QUERY}`,
  keys: `https://images.unsplash.com/photo-1631164159497-3a2408944c35?${UNSPLASH_QUERY}`,
  oldComputer: `https://images.unsplash.com/photo-1561990975-6cfff5661206?${UNSPLASH_QUERY}`,

  // Previous
  vintageComputer: `https://images.unsplash.com/photo-1711346105258-bbb9136592d7?${UNSPLASH_QUERY}`,
  darkSand: `https://images.unsplash.com/photo-1533134486753-c833f0ed4866?${UNSPLASH_QUERY}`,
  hi: `https://images.unsplash.com/reserve/oIpwxeeSPy1cnwYpqJ1w_Dufer%20Collateral%20test.jpg?${UNSPLASH_QUERY}`,
  spectacle: `https://github.com/FormidableLabs/spectacle/blob/main/website/static/img/background-banner.png?raw=true`,
  history: `https://images.unsplash.com/photo-1501139083538-0139583c060f?${UNSPLASH_QUERY}`,
  floppies: `https://images.unsplash.com/photo-1550221927-f7e52256370b?${UNSPLASH_QUERY}`,
  skyscrapers: `https://images.unsplash.com/photo-1449157291145-7efd050a4d0e?${UNSPLASH_QUERY}`,
  fireworks: `https://images.unsplash.com/photo-1498931299472-f7a63a5a1cfa?${UNSPLASH_QUERY}`,
  fireworksMinimal: `https://images.unsplash.com/photo-1532874527472-cf690743dc78?${UNSPLASH_QUERY}`,
  fire: `https://images.unsplash.com/photo-1517594422361-5eeb8ae275a9?${UNSPLASH_QUERY}`,
  nuclear: `https://images.unsplash.com/photo-1630142895963-6996ae6b3a5b?${UNSPLASH_QUERY}`,
  earth: `https://images.unsplash.com/photo-1534996858221-380b92700493?${UNSPLASH_QUERY}`,
  boxingGloves: `https://images.unsplash.com/photo-1583473848882-f9a5bc7fd2ee?${UNSPLASH_QUERY}`,
  brickWall: `https://images.unsplash.com/photo-1546709843-e35cf3d3002d?${UNSPLASH_QUERY}`,
};
