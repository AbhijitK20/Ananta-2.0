import { CityPicker } from "../components/CityPicker";
import { CountryFilmstrip } from "../components/CountryFilmstrip";
import { Hero } from "../components/Hero";
import { Promise, Tips } from "../components/Sections";

export default function HomePage() {
  return (
    <>
      <Hero />
      <CityPicker />
      {/* 100 famous places on a rotating strip. Placed directly after the city
          picker: the picker asks "where do you want to go", and this widens the
          answer to the whole world before the page settles into advice. */}
      <section className="lal-world" aria-labelledby="lal-world-title">
        <h2 className="lal-sr" id="lal-world-title">
          Around the world
        </h2>
        <CountryFilmstrip />
      </section>
      <Promise />
      <Tips />
    </>
  );
}
