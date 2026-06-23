import { useEffect, useRef, useState } from "react";
import { getLatest, subscribe } from "../lib/imageBridge.js";

export default function ImageApp() {
  const [src, setSrc] = useState(getLatest());
  const imgRef = useRef(null);
  useEffect(() => subscribe(setSrc), []);

  const onLoad = () => {
    const img = imgRef.current;
    if (img) { try { window.imageView.sized(img.naturalWidth, img.naturalHeight); } catch { /* ignore */ } }
  };

  if (typeof src !== "string" || !/^data:image\//.test(src)) return null;
  return <img ref={imgRef} src={src} alt="Proof screenshot" onLoad={onLoad} />;
}
