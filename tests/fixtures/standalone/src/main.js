import "./style.css";
import largeAsset from "./large.svg";
import { fixtureKind } from "./helper.mjs";
import { fixtureLabel } from "./component.jsx";

const response = await fetch(new URL("../runtime/data.json", import.meta.url));
const data = await response.json();
const manifestResponse = await fetch(new URL("../runtime/manifest/index.json", import.meta.url));
const manifest = await manifestResponse.json();
const app = document.querySelector("#app");
app.textContent = data.message;
app.dataset.asset = largeAsset;
app.dataset.manifest = manifest.entry;
app.dataset.modules = `${fixtureKind}:${fixtureLabel}`;
