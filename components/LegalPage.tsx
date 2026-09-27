import Link from "next/link";
import type { ReactNode } from "react";

import {
  BUSINESS,
  LEGAL_REVISION,
  copyrightLine,
  isFilled,
  missingOperatorDetails,
} from "../lib/business";

/**
 * The shell every legal page renders inside.
 *
 * WHY ONE SHELL. Three pages that each invent their own heading treatment, their
 * own "last updated" line and their own operator block will drift, and the
 * operator block is the part that has to be right in all three. The revision
 * date, the operator name and the completeness marker come from `lib/business`
 * exactly once, so filling that one file completes all three pages.
 */

export interface LegalSection {
  /** Rendered as the h2. Sentence case, no trailing colon. */
  heading: string;
  /** Optional statute reference, shown as a quiet note under the heading. */
  note?: string;
  body: ReactNode;
}

export interface LegalPageProps {
  title: string;
  summary: string;
  sections: readonly LegalSection[];
}

export function LegalPage({ title, summary, sections }: LegalPageProps) {
  return (
    <div className="g-edit lal-page">
      <div className="g-edit__inner">
        <header>
          <h1 className="g-edit__title">{title}</h1>
          <p className="g-edit__sub">{summary}</p>
          <p className="lal-legal__revision">Last changed {LEGAL_REVISION}</p>
        </header>

        <OperatorBlock />

        <div className="lal-legal__sections">
          {sections.map((section) => (
            <section key={section.heading} aria-labelledby={`s-${slug(section.heading)}`}>
              <h2 id={`s-${slug(section.heading)}`}>{section.heading}</h2>
              {section.note ? <p className="lal-legal__note">{section.note}</p> : null}
              <div className="lal-legal__prose">{section.body}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Heading to id fragment. Avoids a useId in a server component. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Who is running this, and whether that is actually filled in.
 *
 * DPDP Act 2023 section 5(1) obliges a Data Fiduciary to publish its name and
 * the contact details of its Data Fiduciary and Data Processor. That is the
 * requirement this block exists to satisfy, so when the fields are blank the
 * block says so in a warning tone instead of rendering a line of em-dashes that
 * a reader would skim past. A policy that looks complete and is not is worse
 * than one that admits it is a draft.
 */
export function OperatorBlock() {
  const missing = missingOperatorDetails();
  const complete = missing.length === 0;

  return (
    <section aria-labelledby="operator-heading" className="lal-legal__operator">
      <h2 id="operator-heading">Who runs this</h2>

      {complete ? null : (
        <p className="lal-legal__draft" role="note">
          <strong>This document is a draft.</strong> The operator details below
          are not filled in yet. The fields still missing are{" "}
          {missing.map((field) => OPERATOR_FIELD_LABELS[field]).join(", ")}. Until
          they are, this document does not meet the disclosure duty in section
          5(1) of the Digital Personal Data Protection Act, 2023, and it should
          not be treated as a published policy.
        </p>
      )}

      <dl className="lal-legal__fields">
        <OperatorRow label="Operator">{BUSINESS.legalName}</OperatorRow>
        <OperatorRow label="Site">{BUSINESS.productName}</OperatorRow>
        <OperatorRow label="Registered address" lines={BUSINESS.registeredAddress} />
        <OperatorRow label="Governing jurisdiction">{BUSINESS.jurisdiction}</OperatorRow>
        <OperatorRow label="Privacy contact" href={BUSINESS.privacyEmail} />
        <OperatorRow label="Registration number">{BUSINESS.registrationNumber}</OperatorRow>
      </dl>

      <p className="lal-legal__attrib">
        {copyrightLine(BUSINESS)}. Globe imagery &copy;{" "}
        <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">
          OpenStreetMap contributors
        </a>
        , used under the Open Database License.
      </p>
    </section>
  );
}

const OPERATOR_FIELD_LABELS: Record<string, string> = {
  legalName: "the operator's legal name",
  registeredAddress: "a registered address",
  jurisdiction: "a governing jurisdiction",
  privacyEmail: "a privacy contact address",
};

/**
 * One label/value row. A missing value renders as a visible marker rather than
 * an empty `<dd>`, because an empty definition-list item is invisible to a
 * sighted reader and gets skipped entirely by a screen reader.
 */
function OperatorRow({
  label,
  children,
  lines,
  href,
}: {
  label: string;
  children?: ReactNode;
  lines?: readonly string[] | null;
  href?: string | null;
}) {
  let value: ReactNode;
  if (typeof href === "string" && isFilled(href)) {
    value = <a href={`mailto:${href}`}>{href}</a>;
  } else if (Array.isArray(lines)) {
    value = (
      <address>
        {lines.map((line) => (
          <span key={line} className="lal-legal__addrLine">
            {line}
          </span>
        ))}
      </address>
    );
  } else if (children !== undefined && children !== null && children !== "") {
    value = children;
  } else {
    value = <em className="lal-legal__missing">Not filled in</em>;
  }

  return (
    <div className="lal-legal__field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The nav the three legal pages share, so each can reach the other two. */
export function LegalNav({ current }: { current: "privacy" | "terms" | "cookies" }) {
  const links = [
    { href: "/privacy", label: "Privacy policy", key: "privacy" },
    { href: "/terms", label: "Terms of use", key: "terms" },
    { href: "/cookies", label: "Cookie policy", key: "cookies" },
  ] as const;

  return (
    <nav aria-label="Legal" className="lal-legal__nav">
      {links.map((link) =>
        link.key === current ? (
          <span key={link.key} aria-current="page" className="lal-legal__navCurrent">
            {link.label}
          </span>
        ) : (
          <Link key={link.key} href={link.href}>
            {link.label}
          </Link>
        ),
      )}
    </nav>
  );
}
