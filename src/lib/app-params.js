const isNode = typeof window === 'undefined';
const memoryStorage = new Map();
/** @type {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} */
const storage = isNode
	? {
			getItem: (key) => memoryStorage.get(key) ?? null,
			setItem: (key, value) => void memoryStorage.set(key, value),
			removeItem: (key) => void memoryStorage.delete(key),
		}
	: window.localStorage;

const toSnakeCase = (str) => {
	return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

const getAppParamValue = (paramName, { defaultValue = undefined, removeFromUrl = false } = {}) => {
	if (isNode) {
		return defaultValue;
	}
	const storageKey = `base44_${toSnakeCase(paramName)}`;
	const urlParams = new URLSearchParams(window.location.search);
	const searchParam = urlParams.get(paramName);
	if (removeFromUrl) {
		urlParams.delete(paramName);
		const newUrl = `${window.location.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ""
			}${window.location.hash}`;
		window.history.replaceState({}, document.title, newUrl);
	}
	if (searchParam) {
		storage.setItem(storageKey, searchParam);
		return searchParam;
	}
	if (defaultValue) {
		storage.setItem(storageKey, defaultValue);
		return defaultValue;
	}
	const storedValue = storage.getItem(storageKey);
	if (storedValue) {
		return storedValue;
	}
	return null;
}

const getAppParams = () => {
	if (getAppParamValue("clear_access_token") === 'true') {
		storage.removeItem('base44_access_token');
		storage.removeItem('token');
	}
	return {
		appId: getAppParamValue("app_id", { defaultValue: import.meta.env.VITE_BASE44_APP_ID }),
		token: null, // Tokens are now securely handled via HttpOnly cookies
		fromUrl: getAppParamValue("from_url", { defaultValue: window.location.href }),
		functionsVersion: getAppParamValue("functions_version", { defaultValue: import.meta.env.VITE_BASE44_FUNCTIONS_VERSION }),
		appBaseUrl: (() => {
			const url = getAppParamValue("app_base_url", { defaultValue: import.meta.env.VITE_BASE44_APP_BASE_URL });
			if (!url) return null;
			try {
				const parsed = new URL(url);
				const allowedDomains = ['localhost', 'redroof.com', 'base44.com'];
				if (allowedDomains.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
					return url;
				}
			} catch {}
			return import.meta.env.VITE_BASE44_APP_BASE_URL;
		})(),
	}
}

export const appParams = {
	...getAppParams()
}
