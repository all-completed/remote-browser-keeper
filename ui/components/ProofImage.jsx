export default function ProofImage({ src }) {
  if (!src || !/^data:image\//.test(src)) return null;
  return (
    <figure className="proof" onClick={() => { try { window.keeper.viewImage(src); } catch { /* ignore */ } }}>
      <img src={src} alt="The fields the service will fill" />
      <figcaption>The fields the service will fill — proof · click to enlarge</figcaption>
    </figure>
  );
}
