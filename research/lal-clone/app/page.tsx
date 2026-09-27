import { CityPicker } from "../components/CityPicker";
import { Hero } from "../components/Hero";
import { Promise, Tips } from "../components/Sections";

export default function HomePage() {
  return (
    <>
      <Hero />
      <CityPicker />
      <Promise />
      <Tips />
    </>
  );
}
