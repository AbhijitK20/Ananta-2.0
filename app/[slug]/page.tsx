import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CITIES, cities, entriesByCategory, CATEGORY_LABELS } from "../../lib/content";
import "../globals.css";
import "../interior.css";

type Params = { params: Promise<{ slug: string }> };

/* Per-city copy. The live site has a bespoke intro, tagline and FAQ set for
   every city; these are the ones the captures reached. Anything not listed here
   falls back to generated-but-sane text rather than an empty section, because a
   city page with three headings and no copy reads as broken. */
const COPY: Record<string, { tagline: string; intro: string; goodToKnow: string[]; tips: string[]; faq: [string, string][] }> = {
  lisbon: {
    tagline: "Seven hills, azulejos & the sound of fado",
    intro:
      "Draped over seven hills above the Tagus, Lisbon is all pastel facades, blue-tiled churches, tram bells, and a pastry counter worth getting up early for.",
    goodToKnow: [
      "Every neighbourhood has a viewpoint that earns the climb — ask a local which.",
      "Hills are steeper than the map suggests. Wear shoes you can walk 20km in.",
      "The best food is cheapest — go where the queue is all one language.",
    ],
    tips: [
      "Start in Alfama early; by 11am the tram queues swallow the narrow lanes.",
      "Time the Mercado da Ribeira for lunch, not dinner — the light is better and the queue is shorter.",
      "The 28 tram is scenic but a commute in reverse. Ride it once, then walk.",
    ],
    faq: [
      ["How many days do you need in Lisbon?", "Three days is the sweet spot: one for Alfama and Graça, one for Belém, one for the river and a long lunch. Four if you want Sintra."],
      ["Where is the best area to stay in Lisbon?", "Príncipe Real for the best food and walkability, Chiado if you want to walk to everything, Alfama for atmosphere over quiet."],
      ["What are the best things to do in Lisbon?", "The tram 28 at dawn, the tile museum, LX Factory on a Sunday, and a fado night you don’t book online."],
      ["What is the best time to visit Lisbon?", "March–May and September–October. June is hot and August is quiet and hot."],
    ],
  },
  paris: {
    tagline: "The classics, plus the streets between them",
    intro:
      "Everyone gets the Louvre. The better Paris is in the markets, the small museums, and the arrondissements that are one metro stop from where everyone else is not.",
    goodToKnow: [
      "Most big museums are free on the first Sunday of the month — expect queues.",
      "The best food is cheapest — go where the queue is all one language.",
      "The best time to visit Paris is spring and autumn — bring an umbrella.",
    ],
    tips: [
      "Go to the markets, not the terraces — the food is cheaper and better.",
      "Pick one museum per neighbourhood, not five in the Marais on one day.",
      "The best time to visit Paris is spring and autumn — bring an umbrella.",
    ],
    faq: [
      ["How many days do you need in Paris?", "Three for a first trip. Four to add Versailles or Giverny, five if you want the Loire."],
      ["Where is the best area to stay in Paris?", "Le Marais for walkability and food, Belleville for price and edge, the 11th for a real neighbourhood feel."],
      ["What are the best things to do in Paris?", "The Marais markets, Canal Saint-Martin, the Musée de l’Orangerie, and a late dinner where the chefs came to work."],
      ["What is the best time to visit Paris?", "May and September. June, July and August are hot and the Parisians are on holiday."],
    ],
  },
  rome: {
    tagline: "Two thousand years, and the bakeries that survived",
    intro:
      "Rome is a layered city: the Colosseum, then Baroque, then the trattoria where the same family has been making cacio e pepe since before the war.",
    goodToKnow: [
      "The Pantheon has been closed and reopened and closed again — check before you go.",
      "Most of what you came for is a ticket and a walk; the food is the free part.",
      "The best time to visit Rome is spring and autumn — avoid August.",
    ],
    tips: [
      "Combine the Forum and Palatine with the Capitoline museums — same day, same ticket logic.",
      "TheTrastevere is the best neighbourhood to eat in and the worst to park in.",
      "Dress for churches — shoulders and knees get you turned away.",
    ],
    faq: [
      ["How many days do you need in Rome?", "Three for the centre and Trastevere, four to add the Vatican in detail."],
      ["Where is the best area to stay in Rome?", "Monti for walkability, Trastevere for evening, Prati if you want everything quieter."],
      ["What are the best things to do in Rome?", "The Forum at opening time, the Capitoline terrace, Testaccio market, and a cacio e pepe that is not near the Pantheon."],
      ["What is the best time to visit Rome?", "April–June and September–October. August is hot and a third of the city is away."],
    ],
  },
};

const fallback = (name: string) => ({
  tagline: `${name}, the way locals see it`,
  intro: `The places we send our own friends to in ${name}. Every pick here is chosen by someone who lives here and walks it in person.`,
  goodToKnow: [
    `Every neighbourhood in ${name} has a viewpoint worth the climb — ask a local which.`,
    "The best food is the cheapest: go where the queue is all one language.",
    `The best time to visit ${name} is spring and autumn.`,
  ],
  tips: [
    `Start early in the busiest quarter of ${name}; by midday it belongs to the tour buses.`,
    "Pick one thing per neighbourhood rather than five in one afternoon.",
    "Ask before you photograph someone working — it is a request, not a right.",
  ],
  faq: [
    [`How many days do you need in ${name}?`, "Three for a first trip, four to slow down. Two is a taste."],
    [`Where is the best area to stay in ${name}?`, "Where the food is and the walk is easy. Ask a local and follow the answer."],
    [`What are the best things to do in ${name}?`, "The market, one long walk, and one meal you could not get anywhere else."],
    [`What is the best time to visit ${name}?`, "Spring and autumn. Avoid the peak weeks if you can."],
  ] as [string, string][],
});

export function generateStaticParams() {
  return CITIES.map((city) => ({ slug: city.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const city = CITIES.find((c) => c.slug === slug);
  return { title: city?.name ?? "City guide" };
}

export default async function CityPage({ params }: Params) {
  const { slug } = await params;
  const city = CITIES.find((c) => c.slug === slug);
  if (!city) notFound();

  const copy = COPY[city.slug] ?? fallback(city.name);
  const browse = ["restaurants", "sightseeing", "hotels", "tours"]
    .map((tag) => ({ tag, label: CATEGORY_LABELS[tag] ?? tag, items: entriesByCategory(tag) }))
    .filter((s) => s.items.length);

  return (
    <div className="g-edit lal-page">
      <div className="g-cityhero" aria-hidden="true" />
      <div className="g-edit__inner">
        <h1 className="g-edit__title g-edit__title--city">{city.name}</h1>
        <p className="g-edit__sub g-edit__sub--city">{copy.tagline}</p>
        <p className="g-edit__lede">{copy.intro}</p>

        <h2>Good to know</h2>
        <ul className="g-promise__list">
          {copy.goodToKnow.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <h2>Local tips</h2>
        <ul className="g-promise__list">
          {copy.tips.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {city.picks != null && (
          <>
            <h2>Browse {city.name}</h2>
            <p className="g-edit__aside">
              {city.picks} local picks, filtered by category, price and the judgement
              of someone who has been there this year.
            </p>
          </>
        )}

        {browse.map((section) => (
          <section key={section.tag}>
            <h3>{section.label} in {city.name}</h3>
            <div className="g-grid">
              {section.items.slice(0, 9).map((e) => (
                <article key={e.href || e.name} className="g-card">
                  <span className="g-card__body">
                    <span className="g-card__meta">{e.meta}</span>
                    <span className="g-card__title">{e.name}</span>
                    {e.hood && <span className="g-card__hood">{e.hood}</span>}
                    {e.snippet && <span className="g-card__snip">{e.snippet}</span>}
                  </span>
                </article>
              ))}
            </div>
          </section>
        ))}

        <h2>Where to stay in {city.name}</h2>
        <p className="g-edit__aside">
          Compare live hotel prices and availability on the map. We may earn a
          commission at no extra cost to you.
        </p>

        <h2>Before you go</h2>
        <p className="g-edit__aside">
          Travel with a light bag, ask before you photograph, and remember that the
          locals you are here to meet are also on their day off.
        </p>

        <h2>{city.name} travel FAQ</h2>
        <div className="g-faq">
          {copy.faq.map(([q, a]) => (
            <div key={q} className="g-faq__item">
              <h3 className="g-faq__q">{q}</h3>
              <p className="g-faq__a">{a}</p>
            </div>
          ))}
        </div>

        <p className="g-edit__note" style={{ marginTop: 40, textAlign: "center" }}>
          Other cities:{" "}
          {cities
            .filter((c) => c.slug !== city.slug)
            .slice(0, 8)
            .map((c, i, arr) => (
              <span key={c.slug}>
                <a href={`/${c.slug}`}>{c.name}</a>
                {i < arr.length - 1 ? " · " : ""}
              </span>
            ))}
        </p>
      </div>
    </div>
  );
}
