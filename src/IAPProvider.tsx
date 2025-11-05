import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
	initConnection,
	endConnection,
	fetchProducts,
	requestPurchase,
	purchaseUpdatedListener,
	purchaseErrorListener,
	getAvailablePurchases,
	finishTransaction,
	Product,
	Purchase,
	PurchaseError,
} from 'react-native-iap';
import { ANDROID_SUBSCRIPTION_PRODUCT_IDS, IAP_ENABLED, IAP_LOGGING, IAP_OBFUSCATED_ACCOUNT_ID } from '../utils/constants';
import { Platform } from 'react-native';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

export type IAPContextValue = {
	loading: boolean;
	isPremium: boolean;
	products: Product[];
	purchase: (productId?: string) => Promise<void>;
	restore: () => Promise<void>;
	reloadProducts: () => Promise<void>;
};

const Ctx = createContext<IAPContextValue | undefined>(undefined);

function log(...args: any[]) {
	if (IAP_LOGGING) {
		// eslint-disable-next-line no-console
		console.log('[IAP]', ...args);
	}
}

async function acknowledgeIfNeeded(purchase: Purchase) {
	try {
		await finishTransaction({ purchase, isConsumable: false });
		log('finishTransaction ok for', purchase.productId);
	} catch (e) {
		console.error('[IAP] finishTransaction error', e);
	}
}

export const IAPProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [loading, setLoading] = useState<boolean>(true);
	const [isPremium, setIsPremium] = useState<boolean>(false);
	const [products, setProducts] = useState<Product[]>([]);
	const updateSubRef = useRef<ReturnType<typeof purchaseUpdatedListener> | null>(null);
	const errorSubRef = useRef<ReturnType<typeof purchaseErrorListener> | null>(null);

	const reloadProducts = useCallback(async () => {
		if (!IAP_ENABLED || Platform.OS !== 'android') return;
		try {
			log('Fetching products for SKUs:', ANDROID_SUBSCRIPTION_PRODUCT_IDS);
			const items = await fetchProducts({ skus: ANDROID_SUBSCRIPTION_PRODUCT_IDS, type: 'subs' });
			setProducts(items);
			log('Loaded subscriptions:', items.map(i => `${i.id}:${i.displayPrice}`));
			
			// Log detailed product information for debugging
			items.forEach((item, index) => {
				log(`Product ${index}:`, {
					id: item.id,
					price: item.price,
					displayPrice: item.displayPrice,
					platform: item.platform,
					// Log Android-specific fields if available
					...(item.platform === 'android' ? {
						subscriptionOfferDetails: (item as any).subscriptionOfferDetailsAndroid || (item as any).subscriptionOfferDetails
					} : {})
				});
			});
		} catch (e) {
			console.error('[IAP] getSubscriptions error', e);
		}
	}, []);

	const syncPremiumToFirestore = useCallback(async (isPremiumValue: boolean) => {
		const uid = auth().currentUser?.uid;
		if (!uid) return;

		try {
			log('Syncing premium status to Firestore:', isPremiumValue);
			await firestore().collection('users').doc(uid).set({
				isPremium: isPremiumValue
			}, { merge: true });

			// Update OneSignal tags
			await OneSignalService.updateTags({ is_premium: isPremiumValue });
			log('Premium status synced successfully');
		} catch (e) {
			console.error('[IAP] Failed to sync premium status to Firestore', e);
		}
	}, []);

	const evaluateEntitlementFromPurchases = useCallback(async (purchases: Purchase[]) => {
		// Any active (autoRenewingAndroid === true) or acknowledged subscription qualifies
		const hasActive = purchases.some(p => {
			// Android subscription active or acknowledged
			// @ts-expect-error platform guard by presence of android fields
			const isSub = !!p.autoRenewingAndroid || p.isAcknowledgedAndroid === true;
			return isSub;
		});
		setIsPremium(hasActive);

		// Sync to Firestore
		await syncPremiumToFirestore(hasActive);
	}, [syncPremiumToFirestore]);

	const restore = useCallback(async () => {
		if (!IAP_ENABLED || Platform.OS !== 'android') return;
		try {
			const purchases = await getAvailablePurchases();
			log('Available purchases count:', purchases.length);
			for (const p of purchases) {
				// @ts-expect-error android field check
				if (!p.isAcknowledgedAndroid) {
					await acknowledgeIfNeeded(p);
				}
			}
			evaluateEntitlementFromPurchases(purchases);
		} catch (e) {
			console.error('[IAP] restore error', e);
			throw e;
		}
	}, [evaluateEntitlementFromPurchases]);

	const purchase = useCallback(async (productId?: string) => {
		if (!IAP_ENABLED || Platform.OS !== 'android') return;
		try {
			const target = productId || ANDROID_SUBSCRIPTION_PRODUCT_IDS[0];
			log('Requesting subscription for', target);
			
			// Try to find an offerToken from loaded products (Android only)
			const product = products.find(p => p.id === target);
			let offerToken: string | undefined;
			
			if (product && product.platform === 'android') {
				// Prefer strongly-typed android field
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const androidProduct = product as any;
				
				// Look for offer token in subscription offer details
				const offerDetails = androidProduct.subscriptionOfferDetailsAndroid || androidProduct.subscriptionOfferDetails;
				if (offerDetails && offerDetails.length > 0) {
					// Find the base plan "sitara-01" if available, otherwise use the first offer
					const sitara01Offer = offerDetails.find((offer: any) => 
						offer.basePlanId === 'sitara-01' || offer.basePlanId === 'sitara-01'
					);
					offerToken = sitara01Offer?.offerToken || offerDetails[0]?.offerToken;
					log('Found offer token:', offerToken, 'for base plan:', sitara01Offer?.basePlanId || 'default');
				}
			}
			
			await requestPurchase({
				request: {
					android: {
						skus: [target],
						obfuscatedAccountIdAndroid: IAP_OBFUSCATED_ACCOUNT_ID,
						// Required by Google when base plans/offers are configured
						...(offerToken ? { subscriptionOffers: [{ sku: target, offerToken }] } : {}),
					},
				},
				type: 'subs',
			});
		} catch (e) {
			console.error('[IAP] requestSubscription error', e);
			throw e;
		}
	}, [products]);

	useEffect(() => {
		let mounted = true;
		(async () => {
			if (!IAP_ENABLED || Platform.OS !== 'android') {
				setLoading(false);
				return;
			}
			try {
				log('Initializing IAP connection...');
				await initConnection();
				await reloadProducts();
				// After connection, try restore to evaluate entitlement after process restarts
				await restore();
			} catch (e) {
				console.error('[IAP] init error', e);
			} finally {
				if (mounted) setLoading(false);
			}
		})();

		// listeners
		if (Platform.OS === 'android' && IAP_ENABLED) {
			updateSubRef.current = purchaseUpdatedListener(async (purchase: Purchase) => {
				log('purchaseUpdatedListener', purchase.productId);
				try {
					await acknowledgeIfNeeded(purchase);
					setIsPremium(true);
					// Sync to Firestore immediately after purchase
					const uid = auth().currentUser?.uid;
					if (uid) {
						await firestore().collection('users').doc(uid).set({
							isPremium: true
						}, { merge: true });
						await OneSignalService.updateTags({ is_premium: true });
						log('Premium status synced after purchase');
					}
				} catch (e) {
					console.error('[IAP] onUpdate acknowledge error', e);
				}
			});

			errorSubRef.current = purchaseErrorListener((error: any) => {
				console.error('[IAP] purchaseErrorListener', error);
			});
		}

		return () => {
			try {
				updateSubRef.current?.remove();
				errorSubRef.current?.remove();
				endConnection();
			} catch {}
		};
	}, [reloadProducts, restore]);

	const value = useMemo<IAPContextValue>(() => ({
		loading,
		isPremium,
		products,
		purchase,
		restore,
		reloadProducts,
	}), [loading, isPremium, products, purchase, restore, reloadProducts]);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useIAP() {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error('useIAP must be used within IAPProvider');
	return ctx;
}

export default IAPProvider;