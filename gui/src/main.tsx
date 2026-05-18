import * as Tooltip from "@radix-ui/react-tooltip";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/globals.css";

// App-wide Radix Tooltip provider. delayDuration=100 feels
// "immediate" while still letting users drift past affordances
// without flickering; skipDelayDuration=200 lets adjacent tooltips
// (e.g. the Copy/Save pair) chain open without re-paying the
// delay once the first one's been shown.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Tooltip.Provider delayDuration={100} skipDelayDuration={200}>
      <App />
    </Tooltip.Provider>
  </React.StrictMode>,
);
