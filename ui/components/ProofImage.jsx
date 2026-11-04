import { useImageViewer } from "./ImageViewer.jsx";

export default function ProofImage({ src }) {
  const view = useImageViewer();
  if (!src || !/^data:image\//.test(src)) return null;
  return (
    <figure className="proof" onClick={() => view(src)}>
      <img src={src} alt="The fields the service will fill" />
      <figcaption>The fields the service will fill — proof · click to enlarge</figcaption>
    </figure>
  );
}
