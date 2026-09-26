/**
 * The 100 cards in the country filmstrip.
 *
 * Ordering is deliberate and load-bearing, not alphabetical. The strip is a
 * single continuous world tour: adjacent cards are almost neighbours on the map,
 * and a card that scrolls off to the right re-enters from the left, so the
 * sequence has to close back on itself. The loop therefore ends in the Polar
 * region (Antarctic Peninsula) and restarts in Europe (Edinburgh), so the
 * wrap reads as the far south swinging round to the north Atlantic rather than
 * jumping the Pacific backwards.
 *
 * `query` is a Wikimedia Commons search term, not a filename. Hand-writing
 * 100 exact Commons file names is a losing game -- they get renamed, the
 * capitalisation is inconsistent, and roughly one in ten resolves to a
 * disambiguation page or a portrait of the wrong thing. tools/fetch-place-images
 * resolves these at build time, so a miss is a one-word fix here rather than a
 * broken card in the UI.
 *
 * `countryCode` drives the flag/region grouping; `region` drives the continent
 * rail. India's extra weight is intentional: the brief asked for it, and at
 * 8 of 100 it is roughly double its share of world tourism.
 */

export type Place = {
  name: string;
  country: string;
  code: string;
  region: string;
  query: string;
  /** Set on the 50 entries sourced from Lonely Planet's 2027 list. */
  fromLonelyPlanet?: boolean;
  /** Filled in by tools/fetch-place-images.mjs. */
  image?: string;
  /**
   * Filled in by tools/geocode-places.mjs. Nullable on purpose: a card without
   * coordinates still renders in the strip, it just gets no globe pin. Making
   * this required would mean the build breaks on a geocoding miss rather than
   * quietly showing 99 of 100 pins.
   */
  lat?: number;
  lng?: number;
  /** The Wikipedia article the coordinates came from, for attribution/audit. */
  article?: string;
  video?: string;
};

const p = (
  name: string,
  country: string,
  code: string,
  region: string,
  query: string,
  fromLonelyPlanet = false,
): Place => ({ name, country, code, region, query, fromLonelyPlanet });

/* ---------------------------------------------------------------- the tour -- */

export const PLACES: Place[] = [
  // Europe, clockwise from the British Isles
  p("Edinburgh", "Scotland", "GB", "Europe", "Edinburgh castle Scotland"),
  p("London", "United Kingdom", "GB", "Europe", "Tower Bridge London"),
  p("Dublin", "Ireland", "IE", "Europe", "Dublin Ireland Trinity College"),
  p("Killary Fjord", "Ireland", "IE", "Europe", "Killary Fjord Ireland", true),
  p("Reykjavík", "Iceland", "IS", "Europe", "Skogafoss waterfall Iceland"),
  p("Bruges", "Belgium", "BE", "Europe", "Bruges Belgium canals"),
  p("Amsterdam", "Netherlands", "NL", "Europe", "Amsterdam canals"),
  p("Paris", "France", "FR", "Europe", "Eiffel Tower Paris"),
  p("Route de Napoléon", "France", "FR", "Europe", "Mont Cenis pass Alps", true),
  p("Zermatt", "Switzerland", "CH", "Europe", "Matterhorn Zermatt"),
  p("Berlin", "Germany", "DE", "Europe", "Brandenburg Gate Berlin"),
  p("Dessau", "Germany", "DE", "Europe", "Bauhaus Dessau building", true),
  p("Prague", "Czechia", "CZ", "Europe", "Prague Castle"),
  p("Kraków", "Poland", "PL", "Europe", "Krakow Poland old town"),
  p("Vienna", "Austria", "AT", "Europe", "Schonbrunn Vienna"),
  p("Budapest", "Hungary", "HU", "Europe", "Budapest Parliament"),
  p("Šibenik", "Croatia", "HR", "Europe", "Sibenik Croatia", true),
  p("Dubrovnik", "Croatia", "HR", "Europe", "Dubrovnik old town"),
  p("Rome", "Italy", "IT", "Europe", "Colosseum Rome"),
  p("The Veneto", "Italy", "IT", "Europe", "Veneto Italy landscape", true),
  p("Aeolian Islands", "Italy", "IT", "Europe", "Aeolian Islands Sicily", true),
  p("Athens", "Greece", "GR", "Europe", "Acropolis Athens"),
  p("Aegean Sea", "Greece", "GR", "Europe", "Aegean Sea Greece", true),
  p("Barcelona", "Spain", "ES", "Europe", "Sagrada Familia Barcelona"),
  p("Granada", "Spain", "ES", "Europe", "Alhambra Granada", true),
  p("Lisbon", "Portugal", "PT", "Europe", "Lisbon Portugal tram"),
  p("Porto", "Portugal", "PT", "Europe", "Porto Portugal Douro bridge"),
  p("Skanör-Falsterbo", "Sweden", "SE", "Europe", "Skanor Falsterbo", true),
  p("Saint Cuthbert's Way", "England", "GB", "Europe", "Lindisfarne Holy Island", true),
  p("The Tweed", "Scotland", "GB", "Europe", "River Tweed Scotland", true),

  // Africa
  p("Cairo", "Egypt", "EG", "Africa", "Pyramids of Giza"),
  p("Marrakech", "Morocco", "MA", "Africa", "Koutoubia mosque Marrakesh"),
  p("Rabat", "Morocco", "MA", "Africa", "Rabat Morocco", true),
  p("Cape Town", "South Africa", "ZA", "Africa", "Table Mountain Cape Town"),
  p("Victoria Falls", "Zimbabwe", "ZW", "Africa", "Victoria Falls Zambezi"),
  p("Gombe National Park", "Tanzania", "TZ", "Africa", "Chimpanzee Gombe Tanzania", true),
  p("Tsavo National Parks", "Kenya", "KE", "Africa", "Tsavo National Park", true),
  p("São Tomé", "São Tomé & Príncipe", "ST", "Africa", "Sao Tome and Principe", true),

  // Middle East
  p("Istanbul", "Türkiye", "TR", "Middle East", "Hagia Sophia Istanbul"),
  p("Petra", "Jordan", "JO", "Middle East", "Al-Khazneh Treasury Petra"),
  p("Wadi Rum", "Jordan", "JO", "Middle East", "Wadi Rum Jordan desert"),
  p("Oman", "Oman", "OM", "Middle East", "Wahiba Sands Oman desert", true),
  p("Abu Dhabi", "United Arab Emirates", "AE", "Middle East", "Abu Dhabi UAE skyline", true),

  // Asia — India gets the heaviest weighting in the set
  p("Jaipur", "India", "IN", "Asia", "Amber Fort Jaipur"),
  p("Taj Mahal", "India", "IN", "Asia", "Taj Mahal Agra"),
  p("Varanasi", "India", "IN", "Asia", "Varanasi ghat Ganges"),
  p("Ranthambore", "India", "IN", "Asia", "Ranthambore Fort Rajasthan"),
  p("Goa", "India", "IN", "Asia", "Goa India coast"),
  p("Kerala Backwaters", "India", "IN", "Asia", "Kerala backwaters houseboat"),
  p("Darjeeling", "India", "IN", "Asia", "Darjeeling Himalayan Railway", true),
  p("Gujarat", "India", "IN", "Asia", "Somnath temple Gujarat", true),
  p("Bangkok", "Thailand", "TH", "Asia", "Wat Pho Bangkok"),
  p("Hanoi", "Vietnam", "VN", "Asia", "Hanoi Old Quarter"),
  p("Danang", "Vietnam", "VN", "Asia", "Da Nang Vietnam", true),
  p("Bali", "Indonesia", "ID", "Asia", "Bali Ubud rice terrace"),
  p("Singapore", "Singapore", "SG", "Asia", "Marina Bay Singapore"),
  p("Batang Ai National Park", "Malaysia", "MY", "Asia", "Batang Ai National Park", true),
  p("Great Wall", "China", "CN", "Asia", "Mutianyu Great Wall"),
  p("Chengdu", "China", "CN", "Asia", "Jinli street Chengdu", true),
  p("Seoul", "South Korea", "KR", "Asia", "Seoul Gyeongbokgung"),
  p("Tokyo", "Japan", "JP", "Asia", "Tokyo Shibuya crossing"),
  p("Kyoto", "Japan", "JP", "Asia", "Kiyomizu-dera Kyoto"),
  p("Okinawa", "Japan", "JP", "Asia", "Yonezaki Coast Iheya Island Okinawa", true),
  p("Tōhoku", "Japan", "JP", "Asia", "Tohoku Japan", true),
  p("Taiwan", "Taiwan", "TW", "Asia", "Taiwan landscape", true),
  p("Fulidhoo", "Maldives", "MV", "Asia", "Maldives island aerial", true),
  p("Astana", "Kazakhstan", "KZ", "Asia", "View from Bayterek tower Astana", true),

  // Oceania
  p("Sydney", "Australia", "AU", "Oceania", "Sydney Opera House"),
  p("Red Centre", "Australia", "AU", "Oceania", "Uluru Ayers Rock", true),
  p("Queenstown", "New Zealand", "NZ", "Oceania", "Queenstown New Zealand lake"),
  p("Dunedin", "New Zealand", "NZ", "Oceania", "Dunedin New Zealand", true),
  p("Samoa", "Samoa", "WS", "Oceania", "Lalomanu Beach Samoa", true),
  p("New Caledonia", "France", "FR", "Oceania", "New Caledonia aerial lagoon", true),
  p("French Polynesia", "France", "FR", "Oceania", "French Polynesia Bora Bora", true),
  p("Montserrat", "United Kingdom", "GB", "Americas", "Montserrat island Caribbean", true),

  // The Americas, east to west
  p("New York", "United States", "US", "Americas", "New York Manhattan skyline"),
  p("Miami", "United States", "US", "Americas", "Miami Florida skyline Brickell", true),
  p("Maryland", "United States", "US", "Americas", "Maryland State House Annapolis", true),
  p("Rose Island", "United States", "US", "Americas", "Rose Island Rhode Island", true),
  p("Redwoods Parks", "United States", "US", "Americas", "Redwood National Park California", true),
  p("Northeastern Minnesota", "United States", "US", "Americas", "Boundary Waters lake sunset Minnesota", true),
  p("Alaska", "United States", "US", "Americas", "Holgate Glacier Kenai Fjords Alaska", true),
  p("New Mexico", "United States", "US", "Americas", "New Mexico landscape", true),
  p("Havana", "Cuba", "CU", "Americas", "Havana Cuba Malecon"),
  p("Québec", "Canada", "CA", "Americas", "Quebec City Old Town", true),
  p("Prince Edward Island", "Canada", "CA", "Americas", "Prince Edward Island Canada", true),
  p("Cartagena", "Colombia", "CO", "Americas", "Cartagena Colombia walled city"),
  p("Galápagos Islands", "Ecuador", "EC", "Americas", "Galapagos Islands", true),
  p("Machu Picchu", "Peru", "PE", "Americas", "Machu Picchu Peru"),
  p("Rio de Janeiro", "Brazil", "BR", "Americas", "Christ the Redeemer Rio"),
  p("Amazon Rainforest", "Brazil", "BR", "Americas", "Amazon rainforest aerial"),
  p("Salar de Uyuni", "Bolivia", "BO", "Americas", "Salar de Uyuni Bolivia"),
  p("Buenos Aires", "Argentina", "AR", "Americas", "Obelisk of Buenos Aires", true),
  p("Bariloche", "Argentina", "AR", "Americas", "Bariloche Argentina", true),
  p("Torres del Paine", "Chile", "CL", "Americas", "Torres del Paine Chile"),
  p("León", "Nicaragua", "NI", "Americas", "Leon Nicaragua", true),
  p("Monteverde", "Costa Rica", "CR", "Americas", "Monteverde hanging bridges cloud forest", true),
  p("Bocas del Toro", "Panama", "PA", "Americas", "Bocas del Toro Panama", true),
  p("Valle de Guadalupe", "Mexico", "MX", "Americas", "Valle de Guadalupe Mexico", true),

  // Polar last: it sits between the Atlantic and the Pacific routes, and the
  // strip's wrap-around is the only place a continent edge reads as intentional.
  p("Antarctic Peninsula", "Antarctica", "AQ", "Polar", "Antarctic Peninsula", true),
];

/**
 * Coordinates, keyed by the same slug tools/fetch-place-images.mjs uses.
 *
 * Kept as a separate generated block rather than a seventh argument to p(),
 * because the list above is hand-authored and readable and 100 extra numeric
 * arguments would bury it. Regenerate with `node tools/geocode-places.mjs`.
 */
import { COORDS, type Coords } from "./place-coords";

const slugOf = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

for (const place of PLACES) {
  const hit: Coords | undefined = COORDS[slugOf(place.name)];
  if (hit) {
    place.lat = hit.lat;
    place.lng = hit.lng;
    place.article = hit.article;
  }
}

/** The subset that can be plotted on the globe. */
export const PLOTTABLE = PLACES.filter((x) => x.lat != null && x.lng != null);

export const REGION_ORDER = [
  "Europe",
  "Africa",
  "Middle East",
  "Asia",
  "Oceania",
  "Americas",
  "Polar",
] as const;

export const placeCount = PLACES.length;
export const indiaCount = PLACES.filter((x) => x.code === "IN").length;
export const lonelyPlanetCount = PLACES.filter((x) => x.fromLonelyPlanet).length;
