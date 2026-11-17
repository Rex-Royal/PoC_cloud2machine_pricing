'use client';

import React, { memo, useDeferredValue, useMemo, useState } from 'react';
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react';
import type { TranslationKey } from '../../i18n/translations.ts';
import { ALL_CUSTOMERS_ID } from '#fleet-sync';
import type { CustomerOption } from '#firmware-core';

const MAX_RENDERED_CUSTOMER_OPTIONS = 40;

interface IndexedCustomerOption extends CustomerOption {
  pathPrefix: string;
  leafName: string;
  leafLower: string;
  fullLower: string;
}

export interface CustomerComboboxProps {
  customers: readonly CustomerOption[];
  selectedCustomerId: string;
  onSelectCustomer: (customerId: string) => void;
  t: (key: TranslationKey) => string;
}

/**
 * Searchable hierarchical customer selector with deferred query filtering
 * and prefix/leaf/path match ranking.
 */
export const CustomerCombobox = memo(function CustomerCombobox({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  t,
}: CustomerComboboxProps) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const indexedCustomers = useMemo<IndexedCustomerOption[]>(() => {
    const allCustomersOption: IndexedCustomerOption = {
      id: ALL_CUSTOMERS_ID,
      name: `★ All Customers — Search Entire Fleet (${customers.length} customers)`,
      rawName: 'All Customers',
      parentCustomerId: null,
      pathPrefix: '★ ',
      leafName: `All Customers — Search Entire Fleet (${customers.length} customers)`,
      leafLower: 'all customers search entire fleet',
      fullLower: 'all customers search entire fleet',
    };
    const mapped = customers.map((c) => {
      const lastSep = c.name.lastIndexOf(' › ');
      const pathPrefix = lastSep !== -1 ? c.name.slice(0, lastSep + 3) : '';
      const leafName = lastSep !== -1 ? c.name.slice(lastSep + 3) : c.name;
      return {
        ...c,
        pathPrefix,
        leafName,
        leafLower: leafName.toLowerCase(),
        fullLower: `${c.name} ${c.rawName || ''}`.toLowerCase(),
      };
    });
    return [allCustomersOption, ...mapped];
  }, [customers]);

  const selectedCustomerObj = useMemo(
    () => indexedCustomers.find((c) => c.id === selectedCustomerId) || indexedCustomers[0] || null,
    [indexedCustomers, selectedCustomerId]
  );

  const { visibleOptions, totalMatches } = useMemo(() => {
    const term = deferredQuery.toLowerCase().trim();
    if (!term) {
      const topSlice = indexedCustomers.slice(0, MAX_RENDERED_CUSTOMER_OPTIONS);
      if (
        selectedCustomerObj &&
        !topSlice.some((c) => c.id === selectedCustomerObj.id)
      ) {
        topSlice[topSlice.length - 1] = selectedCustomerObj;
      }
      return { visibleOptions: topSlice, totalMatches: indexedCustomers.length };
    }

    const leafPrefixMatches: IndexedCustomerOption[] = [];
    const leafSubstringMatches: IndexedCustomerOption[] = [];
    const pathMatches: IndexedCustomerOption[] = [];

    for (const c of indexedCustomers) {
      if (c.leafLower.startsWith(term)) {
        leafPrefixMatches.push(c);
      } else if (c.leafLower.includes(term)) {
        leafSubstringMatches.push(c);
      } else if (c.fullLower.includes(term)) {
        pathMatches.push(c);
      }
    }

    const combined = [...leafPrefixMatches, ...leafSubstringMatches, ...pathMatches];
    return {
      visibleOptions: combined.slice(0, MAX_RENDERED_CUSTOMER_OPTIONS),
      totalMatches: combined.length,
    };
  }, [indexedCustomers, deferredQuery, selectedCustomerObj]);

  return (
    <Combobox
      immediate
      value={selectedCustomerObj}
      onChange={(cust: IndexedCustomerOption | null) => {
        setQuery('');
        onSelectCustomer(cust?.id || ALL_CUSTOMERS_ID);
      }}
      onClose={() => setQuery('')}
    >
      <div className="combobox-container">
        <div className="combobox-input-wrap">
          <span className="combobox-search-icon" aria-hidden="true">
            ⌕
          </span>
          <ComboboxInput
            id="customer-combobox-input"
            className="combobox-input"
            placeholder={t('customerComboboxPlaceholder')}
            displayValue={(cust: IndexedCustomerOption | null) => cust?.name ?? ''}
            onChange={(event) => setQuery(event.target.value)}
          />
          {((selectedCustomerId && selectedCustomerId !== ALL_CUSTOMERS_ID) || query) && (
            <button
              type="button"
              className="combobox-clear-btn"
              title="Reset to All Customers (Search Entire Fleet)"
              aria-label="Reset to All Customers"
              onClick={(e) => {
                e.stopPropagation();
                setQuery('');
                onSelectCustomer(ALL_CUSTOMERS_ID);
              }}
            >
              ✕
            </button>
          )}
          <ComboboxButton
            className="combobox-chevron-btn"
            aria-label="Toggle customer list"
          >
            ▾
          </ComboboxButton>
        </div>

        <ComboboxOptions className="combobox-listbox">
          {visibleOptions.length === 0 ? (
            <div className="combobox-empty">{t('customerNoMatches')}</div>
          ) : (
            <>
              {visibleOptions.map((c) => (
                <ComboboxOption key={c.id} value={c} className="combobox-option">
                  <span>
                    {c.pathPrefix && (
                      <span className="combobox-path-prefix">{c.pathPrefix}</span>
                    )}
                    <span className="combobox-leaf-name">{c.leafName}</span>
                  </span>
                  {c.id === selectedCustomerId && (
                    <span
                      style={{
                        color: 'var(--corporate-accent)',
                        fontWeight: 700,
                      }}
                    >
                      ✓
                    </span>
                  )}
                </ComboboxOption>
              ))}
              {totalMatches > MAX_RENDERED_CUSTOMER_OPTIONS && (
                <div
                  className="combobox-empty"
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  {t('paginationShowing')} {MAX_RENDERED_CUSTOMER_OPTIONS} {t('paginationOf')}{' '}
                  {totalMatches} — type to narrow results
                </div>
              )}
            </>
          )}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
});
