import Link from "next/link";

export function Hero() {
  return (
    <section className="lal-hero lal-box">
      <div className="lal-container lal-hero__inner">
        <p className="lal-hero__eyebrow lal-fit">SEE A CITY LIKE A LOCAL</p>
        <h1 className="lal-hero__title lal-fit">Find the places locals love</h1>
        <p className="lal-hero__desc lal-fit">
          Skip the tourist traps. Start with a city and get straight to the cafés,
          bars, culture and hidden gems that locals swear by.
        </p>

        <div className="lal-search__wrap">
        <form className="lal-search" action="/cities" method="get" role="search">
          <input
            className="lal-search__input"
            type="search"
            name="q"
            placeholder="Enter City Name"
            aria-label="Enter City Name"
          />
          <button type="submit" className="lal-search__submit" aria-label="Search">
            <svg width="16" height="16" viewBox="0 0 512 512" aria-hidden="true" fill="currentColor">
              <path d="M505 442.7L405.3 343c-4.5-4.5-10.6-7-17-7H372c27.6-35.3 44-79.7 44-128C416 93.1 322.9 0 208 0S0 93.1 0 208s93.1 208 208 208c48.3 0 92.7-16.4 128-44v16.3c0 6.4 2.5 12.5 7 17l99.7 99.7c9.4 9.4 24.6 9.4 33.9 0l28.3-28.3c9.4-9.4 9.4-24.6.1-34zM208 336c-70.7 0-128-57.2-128-128 0-70.7 57.2-128 128-128s128 57.3 128 128-57.3 128-128 128z" />
            </svg>
          </button>
        </form>
        </div>

        <p className="lal-hero__hint lal-fit">
          Try &ldquo;Lisbon&rdquo;, &ldquo;London&rdquo;, &ldquo;New York City&rdquo; or
          &ldquo;Paris&rdquo;
        </p>
      </div>
    </section>
  );
}
