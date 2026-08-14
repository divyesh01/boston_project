import React from 'react';

export default function AuditCategoryFilter({ activeCategory, onSelectCategory }) {
  const categories = [
    { key: 'ALL', label: 'All Events' },
    { key: 'AUTH', label: 'Auth & Login' },
    { key: 'SECURITY', label: 'Security & Anomalies' },
    { key: 'REVENUE', label: 'Rate & Financial' },
    { key: 'DATA', label: 'Report Imports' }
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 my-3">
      {categories.map((cat) => {
        const isActive = activeCategory === cat.key;
        return (
          <button
            key={cat.key}
            type="button"
            onClick={() => onSelectCategory(cat.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              isActive
                ? 'bg-red-700 text-white shadow-sm font-semibold'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900'
            }`}
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );
}
