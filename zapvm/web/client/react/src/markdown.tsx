import { Streamdown } from "streamdown";
import "streamdown/styles.css";

export default function Markdown({ content, animating, className }: { content: string; animating: boolean; className?: string }) {
  return <Streamdown className={className} disallowedElements={["hr"]} isAnimating={animating}>{content}</Streamdown>;
}
