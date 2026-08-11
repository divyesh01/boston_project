import * as React from "react";
const MOBILE_BREAKPOINT = 768;
export function useIsMobile() {
    const [isMobile, setIsMobile] = React.useState(undefined);
    React.useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
            setIsMobile(false);
            return;
        }
        let mql;
        try {
            mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
        }
        catch {
            setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
            return;
        }
        const onChange = () => {
            try {
                setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
            }
            catch { }
        };
        const add = mql.addEventListener ? mql.addEventListener.bind(mql) : mql.addListener.bind(mql);
        const remove = mql.removeEventListener ? mql.removeEventListener.bind(mql) : mql.removeListener.bind(mql);
        add("change", onChange);
        setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
        return () => remove("change", onChange);
    }, []);
    return !!isMobile;
}
