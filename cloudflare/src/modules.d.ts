// Wrangler bundles *.html imports as text modules.
declare module "*.html" {
  const text: string;
  export default text;
}
