export type City = {
  slug: string;
  name: string;
  image: string;
  featured?: boolean;
  blurb?: string;
};

export const CITIES: City[] = [
  {
    slug: "new-york-city",
    name: "New York City",
    image: "/nyc.jpg",
    featured: true,
    blurb:
      "90+ picks from the team behind Like A Local Tours - we live here, we eat here, and we run the tours. Explore NYC like a real local.",
  },
  { slug: "paris", name: "Paris", image: "/paris.jpg" },
  { slug: "rome", name: "Rome", image: "/rome.jpg" },
  { slug: "london", name: "London", image: "/london.jpg" },
  { slug: "barcelona", name: "Barcelona", image: "/barcelona.jpg" },
  { slug: "amsterdam", name: "Amsterdam", image: "/amsterdam.jpg" },
  { slug: "lisbon", name: "Lisbon", image: "/lisbon.jpg" },
  { slug: "prague", name: "Prague", image: "/prague.jpg" },
  { slug: "vienna", name: "Vienna", image: "/vienna.jpg" },
  { slug: "budapest", name: "Budapest", image: "/budapest.jpg" },
  { slug: "venice", name: "Venice", image: "/venice.jpg" },
  { slug: "athens", name: "Athens", image: "/athens.jpg" },
  { slug: "berlin", name: "Berlin", image: "/berlin.jpg" },
];

export type Tip = {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  date: string;
  image: string;
};

export const TIPS: Tip[] = [
  {
    slug: "what-to-buy-in-georgia",
    title: "What to Buy in Georgia (and What to Skip)",
    category: "Tips",
    date: "September 3, 2026",
    image: "/tip-georgia.jpg",
    excerpt:
      "Minankari enamel, undyed churchkhela, qvevri wine and blue fenugreek - what is genuinely Georgian, how to spot the fakes, and…",
  },
  {
    slug: "what-to-buy-in-portugal",
    title: "What to Buy in Portugal (and What to Skip)",
    category: "Tips",
    date: "September 1, 2026",
    image: "/tip-portugal.jpg",
    excerpt:
      "Azulejos bought legally by the piece, tinned fish, 1887 soap, native-breed wool and Azores tea - what is worth carrying…",
  },
  {
    slug: "what-to-buy-in-poland",
    title: "What to Buy in Poland (and What to Skip)",
    category: "Tips",
    date: "August 29, 2026",
    image: "/tip-poland.jpg",
    excerpt:
      "Kabanos, sheep cheese and honey from working markets, Boleslawiec stoneware, and ceramics from social-enterprise workshops - plus why the Cluth…",
  },
  {
    slug: "what-to-buy-in-latvia",
    title: "What to Buy in Latvia (and What to Skip)",
    category: "Tips",
    date: "August 26, 2026",
    image: "/tip-latvia.jpg",
    excerpt:
      "Sigulda walking sticks, linen, rye bread and workshop ceramics - what is genuinely Latvian, what to avoid, and where loca…",
  },
  {
    slug: "responsible-london",
    title: "Responsible London: Where to Stay, Book and Shop",
    category: "Guides",
    date: "August 24, 2026",
    image: "/tip-london.jpg",
    excerpt:
      "Social enterprise hotels, tours guided by people who have been hereborn, refugee-tasting cooking classes and charity shops that fund garme…",
  },
  {
    slug: "responsible-lisbon",
    title: "Responsible Lisbon: Shop, Stay and Eat Where It Counts",
    category: "Guides",
    date: "August 23, 2026",
    image: "/tip-lisbon.jpg",
    excerpt:
      "Portuguese-owned tile shops, certified sustainable hotels, migrant-led walks in Mouraria and the markets where tourists actually eat.",
  },
];

export type Place = {
  name: string;
  category: string;
  area: string;
  hours: string;
  note: string;
  image: string;
};

export const PLACES: Record<string, Place[]> = {
  lisbon: [
    {
      name: "Cervejaria Ramiro",
      category: "Seafood",
      area: "Intendente",
      hours: "12:00 – 23:00",
      note: "Garlic prawns and a cold Sagres that justifies the queue. Go at 12:15 or after 14:30.",
      image: "/lisbon.jpg",
    },
    {
      name: "Mercado de Campo de Ourique",
      category: "Market",
      area: "Campo de Ourique",
      hours: "08:00 – 19:00",
      note: "The practical Saturday stop. Cheeses, cured fish and fruit from small producers.",
      image: "/tip-portugal.jpg",
    },
    {
      name: "Livraria Bertrand",
      category: "Books",
      area: "Chiado",
      hours: "10:00 – 20:00",
      note: "Second-hand shelves in the back. A 1930 edition of *Os Maias* was €6.",
      image: "/tip-lisbon.jpg",
    },
    {
      name: "Miradouro de Santa Catarina",
      category: "Viewpoint",
      area: "Bairro Alto",
      hours: "Open 24 hours",
      note: "Better at 8pm than at noon, and the kiosk next door rents chairs for €2.",
      image: "/london.jpg",
    },
  ],
  "new-york-city": [
    {
      name: "Xi'an Famous Foods",
      category: "Noodles",
      area: "Lower East Side",
      hours: "11:00 – 22:30",
      note: "The hand-pulled liangpi stall is the draw. Cash only, and the line moves fast.",
      image: "/nyc.jpg",
    },
    {
      name: "The Elevated Acre",
      category: "Park",
      area: "Lower East Side",
      hours: "07:00 – 01:00",
      note: "Actual trees, actual quiet, four minutes from the noise. Locals use it as an office.",
      image: "/london.jpg",
    },
    {
      name: "Judd Foundation",
      category: "Books",
      area: "East Village",
      hours: "10:00 – 19:00",
      note: "Design, architecture and concrete poetry. Free, and nobody rushes you.",
      image: "/tip-london.jpg",
    },
  ],
};

export const NAV = [
  { href: "/plan", label: "Plan a Trip" },
  { href: "/about", label: "About" },
  { href: "/blog", label: "Blog" },
  // Replaces the Contact entry. The assistant is the one part of this site that
  // is actually ours rather than reconstructed, and it is unreachable by
  // browsing if the only route to it is /oracle. /contact still exists and still
  // routes; it just is not what the nav advertises.
  { href: "/oracle", label: "Ask the AI" },
  // Local Legends is the gamified layer -- the stamp album over the 890 picks,
  // with quests, XP and streaks. /stamps is the collection itself, which is what
  // the product is, and it is the one game route that shows the whole shape of a
  // player's progress at a glance.
  //
  // This replaces "Partner With Us". Two reasons, one of them practical: the nav
  // has a finite width and a sixth item is the point at which it starts wrapping
  // on a laptop, and a marketing page for partners is a worse use of the last
  // slot than the thing visitors actually came for. /partners still routes.
  { href: "/stamps", label: "Local Legends" },
];

/**
 * Local Legends is ours, not the live site's, so it is kept out of NAV on
 * purpose. The row has about 18px of slack at the 1440px width
 * tools/verify.mjs measures, so a sixth <li> wraps the header, grows it from
 * 124px to 187px and pushes 50 of the 56 measured elements down by 63px.
 *
 * It is rendered separately as an absolutely positioned child of the same list,
 * so it is out of flow: the list's box and every measured link keep their
 * geometry, and it sits in the free gap between the logo and the nav.
 */
/**
 * Was the header's absolutely positioned "Local Legends" link, pointing at the
 * marketing page for the game. It is no longer rendered: NAV ends in a
 * "Local Legends" item and two identical labels in one header look broken.
 * /local-legends still routes.
 */
export const GAME_LINK = { href: "/local-legends", label: "Local Legends" };

export const PROMISES = [
  {
    title: "Verified by locals",
    body: "Every pick is chosen and checked by people who live there.",
  },
  {
    title: "No tourist traps",
    body: "Real neighbourhood spots, filtered by category and budget.",
  },
  {
    title: "Travel sustainably",
    body: "Spot the eco-friendly, community-first places with one filter.",
  },
];

export const CATEGORIES = [
  "All",
  "Eat",
  "Drink",
  "See",
  "Shop",
  "Do",
];
