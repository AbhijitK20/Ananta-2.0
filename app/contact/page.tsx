import type { Metadata } from "next";

import "../globals.css";
import "../interior.css";

export const metadata: Metadata = {
  title: "Contact us",
  description: "Questions, corrections, or a place we should know about?",
};

const DETAILS = [
  { label: "General", value: "hello@likealocalguide.com", href: "mailto:hello@likealocalguide.com" },
  { label: "Partnerships", value: "partners@likealocalguide.com", href: "mailto:partners@likealocalguide.com" },
  { label: "Press", value: "press@likealocalguide.com", href: "mailto:press@likealocalguide.com" },
];

export default function ContactPage() {
  return (
    <div className="g-edit g-edit--contact lal-page">
      <div className="g-edit__inner">
        <h1 className="g-edit__title g-edit__title--contact">Contact us</h1>
        <p className="g-edit__sub">
          We read every message. Tell us how we can help plan your trip.
        </p>

        <div className="g-split">
          <form className="g-form" action="#">
            <div>
              <label htmlFor="c-name">Name</label>
              <input id="c-name" name="name" type="text" autoComplete="name" />
            </div>
            <div>
              <label htmlFor="c-email">Email</label>
              <input id="c-email" name="email" type="email" autoComplete="email" />
            </div>
            <div>
              <label htmlFor="c-topic">Topic</label>
              <select id="c-topic" name="topic" defaultValue="general">
                <option value="general">General question</option>
                <option value="correction">Correct or suggest a place</option>
                <option value="partnership">Partnership</option>
                <option value="press">Press</option>
              </select>
            </div>
            <div>
              <label htmlFor="c-msg">Message</label>
              <textarea id="c-msg" name="message" />
            </div>
            <button type="submit" className="g-submit">
              Send message
            </button>
          </form>

          <div>
            <h3>Get in touch</h3>
            <p className="g-detail">
              Questions, corrections, or a place we should know about? Send us a note
              with the form and we will get back to you.
            </p>
            {DETAILS.map((d) => (
              <p key={d.label} className="g-detail g-detail__row">
                <span className="g-detail__label">{d.label}</span>
                <span className="g-detail__value">
                  <a href={d.href}>{d.value}</a>
                </span>
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
