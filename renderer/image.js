const img = document.getElementById("img");

window.imageView.onData((dataUrl) => {
  if (typeof dataUrl === "string" && /^data:image\//.test(dataUrl)) img.src = dataUrl;
});

// Once the image is decoded, report its natural size so main fits the window.
img.addEventListener("load", () => {
  window.imageView.sized(img.naturalWidth, img.naturalHeight);
});
