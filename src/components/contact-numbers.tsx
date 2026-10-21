/**
 * Phone and mobile numbers for one contact.
 *
 * The number is displayed exactly as the source row carries it (country code and
 * extension included) and linked with a valid `tel:` href. Copy and call are both
 * available, and a record with several numbers lists each one once. A mobile is
 * labelled separately from a work/landline number; nothing is merged or invented.
 */

import { Copy, Phone, Smartphone } from "lucide-react";
import { contactPhoneNumbers, telHref } from "@/shared/phone";
import { cn } from "@/lib/utils";

export interface ContactNumbersProps {
  contact: {
    phone?: string | null;
    mobile?: string | null;
    additionalPhones?: string[] | null;
    attributes?: Record<string, string> | null;
  };
  className?: string;
  /** Hide the "Phone"/"Mobile" label in dense rows. */
  showLabels?: boolean;
  /** Show the small copy action (default true). */
  copyable?: boolean;
}

function NumberLine({
  value,
  label,
  mobile,
  showLabels,
  copyable,
}: {
  value: string;
  label: string;
  mobile: boolean;
  showLabels: boolean;
  copyable: boolean;
}) {
  const Icon = mobile ? Smartphone : Phone;
  const href = telHref(value);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {showLabels ? (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
      {href ? (
        <a href={href} className="truncate hover:text-primary hover:underline" title={`Call ${value}`}>
          {value}
        </a>
      ) : (
        <span className="truncate">{value}</span>
      )}
      {copyable ? (
        <button
          type="button"
          className="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
          title={`Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label.toLowerCase()} ${value}`}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(value);
          }}
        >
          <Copy className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** Every available number, or `null` when the record carries none. */
export function ContactNumbers({ contact, className, showLabels = true, copyable = true }: ContactNumbersProps) {
  const numbers = contactPhoneNumbers(contact);
  if (!numbers.all.length) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
      {numbers.phone ? <NumberLine value={numbers.phone} label="Phone" mobile={false} showLabels={showLabels} copyable={copyable} /> : null}
      {numbers.mobile ? <NumberLine value={numbers.mobile} label="Mobile" mobile showLabels={showLabels} copyable={copyable} /> : null}
      {numbers.additional.map((value, index) => (
        <NumberLine
          key={`${value}-${index}`}
          value={value}
          label={`Phone ${index + 2}`}
          mobile={false}
          showLabels={showLabels}
          copyable={copyable}
        />
      ))}
    </div>
  );
}
