// Dense, responsive grid for search-mode + bottom catalog. Denser glass
// (panel-glass) signals "settle in and browse" per the design doc's
// top→bottom airy→solid gradient.

import React from "react";

interface Props {
  children: React.ReactNode;
  dense?: boolean;
}

export default function MarketplaceGrid({ children, dense }: Props) {
  return (
    <div className={`grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 ${dense ? "panel-glass p-3 rounded-lg" : ""}`}>
      {children}
    </div>
  );
}
