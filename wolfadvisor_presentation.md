# WolfAdvisor — Présentation complète du projet

## Qu'est-ce que WolfAdvisor ?

WolfAdvisor est un assistant de trading personnel entièrement automatisé, conçu pour détecter des opportunités d'achat en bourse sur le marché Euronext Paris. Il surveille en permanence 94 instruments financiers (ETF et actions françaises/européennes) éligibles au PEA (Plan d'Épargne en Actions), et prévient son utilisateur quand une opportunité d'achat intéressante se présente — sans qu'il ait besoin de passer sa journée devant un écran.

Le nom "Wolf" reflète la philosophie du projet : un prédateur patient qui attend le bon moment pour agir.

---

## À quel problème répond-il ?

Un investisseur particulier qui travaille dans la journée ne peut pas surveiller les marchés en temps réel. Il rate souvent les "dips" — ces chutes brutales et temporaires qui sont historiquement les meilleurs points d'entrée pour acheter. WolfAdvisor résout ce problème en automatisant la surveillance, l'analyse et la notification, 24/7, sans intervention humaine.

---

## La stratégie : "Buy the dip"

WolfAdvisor repose sur une stratégie simple et éprouvée :

1. **Attendre qu'un titre chute significativement** (au moins -1.5% sur la journée)
2. **Vérifier que les indicateurs techniques confirment une survente** (RSI bas, volatilité contrôlée)
3. **Acheter à ce moment-là** avec un ticket d'au moins 600€
4. **Revendre quand le titre a rebondi d'au moins +6% net** (après déduction de tous les frais)

L'idée n'est pas de trader tous les jours, mais d'agir uniquement quand les conditions sont réunies. Le bot peut rester silencieux pendant des semaines si le marché est calme — c'est normal et voulu.

---

## Comment fonctionne le scoring ?

À chaque scan (toutes les 5 minutes pendant les heures de bourse), WolfAdvisor calcule un **"Score Wolf"** sur 100 pour chaque instrument, basé sur 3 critères :

- **Amplitude de la baisse du jour** : une chute de -4% donne 35 points, -2.5% donne 25 points, -1.5% donne 12 points
- **RSI 14 jours** (Relative Strength Index) : un RSI sous 30 (survente forte) donne 30 points, sous 40 donne 20 points
- **Pénalité de volatilité** : un titre trop volatil (>4% de vol quotidienne) perd 25 points, car le rebond est moins prévisible

Un signal est émis quand le score atteint **60/100 ou plus**, que la baisse est d'au moins -1.5%, et que la volatilité reste sous 5%.

Un filtre anti-crash bloque tous les signaux si le CAC 40 chute de plus de -2% (marché en panique, pas le moment d'acheter).

---

## Où obtient-il ses données ?

- **Cours de bourse** : Yahoo Finance (API gratuite), via un serveur intermédiaire hébergé sur Cloudflare Workers. Les données sont mises en cache pour éviter de surcharger l'API.
- **Actualités** : Flux RSS de Google News Finance et Géopolitique, Yahoo Finance France — agrégés et analysés automatiquement pour détecter leur impact (positif, négatif, neutre) sur les secteurs concernés.
- **VIX** (indice de peur du marché) : cours réel depuis Yahoo Finance.

Toutes les données sont gratuites. Le coût d'hébergement est de 0€ (Cloudflare Workers gratuit + GitHub Pages gratuit).

---

## L'architecture technique

WolfAdvisor est composé de deux parties :

### 1. Le backend (Cloudflare Worker)
Un serveur léger qui tourne en permanence sur le cloud Cloudflare :
- **Cron toutes les 5 minutes** pendant les heures Euronext (9h15–17h15, lundi–vendredi)
- Scanne les 94 instruments de la watchlist PEA
- Calcule RSI, volatilité 20 jours, et Score Wolf pour chacun
- Émet des signaux "DIP ACHAT" quand les conditions sont réunies
- **Suit le P&L en temps réel** de chaque signal émis (cours actuel, gain/perte net, high watermark)
- **Vérifie les alertes personnalisées** même quand l'utilisateur n'a pas l'app ouverte
- Envoie des **notifications Discord** : nouveaux signaux, progression vers l'objectif (50%, 75%, 100%), bilan quotidien à 17h35
- Stocke tout en base de données (Cloudflare KV)

### 2. Le frontend (GitHub Pages)
Une interface web légère, accessible depuis un navigateur ou un téléphone :
- **10 onglets** : Briefing, Actualités, Radar, Signaux Wolf, Backtest, Capital, Alertes, Ordres, Performance, Stress Test
- Se synchronise avec le backend toutes les 30–60 secondes
- Fonctionne aussi en mode dégradé si le backend est indisponible (fallback sur des proxies CORS publics)

### Sécurité
- Authentification par token (header X-Wolf-Token)
- Aucune clé API exposée côté frontend
- CORS restreint au domaine GitHub Pages de l'utilisateur

---

## Les fonctionnalités détaillées

### Radar temps réel
Affiche les 8 instruments surveillés en priorité avec leurs indicateurs réels (RSI, volatilité, variation du jour, Score Wolf). Classés par opportunité : DIP ACHAT → SIGNAL SORTIE → ATTENDRE.

### Signaux Wolf
Chaque signal émis est tracké automatiquement :
- Prix d'achat simulé au moment du signal
- Cours actuel mis à jour en temps réel
- P&L net calculé avec les frais Fortuneo (0.35% à l'achat ET à la vente)
- Barre de progression vers l'objectif +6% net
- High watermark (meilleur cours atteint depuis le signal)
- Clôture automatique après 30 jours ou manuelle

### Alertes personnalisées
L'utilisateur peut créer des alertes sur n'importe quel instrument, avec 8 conditions possibles :
- Baisse/hausse en % sur la journée
- Prix sous/au-dessus d'un seuil
- RSI sous/au-dessus d'un niveau
- Cassure de moyenne mobile 50 jours
- Sous-performance vs CAC 40 sur 5 jours
- Score Wolf dépassant un seuil

Les alertes sont vérifiées **côté serveur** toutes les 5 minutes, même si le téléphone est éteint. Notification via Discord.

### Gestion de portefeuille
- Saisie des positions réelles (instrument, quantité, prix de revient)
- Valorisation en temps réel avec cours Yahoo Finance
- P&L par ligne et total, avec variation du jour
- Alerte de concentration (si une ligne dépasse X% du portefeuille)
- Calcul du position sizing optimal

### Backtest
Simulation de la stratégie dip/rebond sur 1 an de données historiques réelles Yahoo Finance. Paramètres ajustables : instrument, seuil de dip, durée de détention, capital initial. Résultat avec capital final, taux de réussite, gain moyen net par trade, graphique d'évolution.

### Stress test
Simulation de l'impact de scénarios géopolitiques sur le portefeuille : guerre tarifaire, hausse BCE, ralentissement Chine, choc pétrolier, crash 2008, COVID. Impact calculé par secteur.

### Carnet d'ordres
Enregistrement de tous les ordres passés (achat/vente) avec calcul automatique des frais Fortuneo, suivi du P&L par trade, export CSV et JSON, import de backup.

### Notifications Discord
Canal unique pour toutes les notifications, reçues sur téléphone :
- 🟢 Nouveau signal DIP ACHAT (avec score, RSI, cours, ticket simulé)
- 🟡🟠🟢 Progression P&L vers l'objectif (50%, 75%, 100%)
- 🔔 Alertes personnalisées déclenchées
- 🐺 Bilan quotidien à 17h35 (résumé de la journée)

---

## Le modèle de frais intégré

WolfAdvisor est calibré pour le **compte Fortuneo Starter** :
- Frais par ordre : **0.35%** du montant
- 1er ordre du mois gratuit si ≤ 500€ (réservé au DCA, pas aux trades opportunistes)
- Tous les calculs de P&L, backtest et signaux intègrent les frais à l'achat ET à la vente
- L'objectif de +6% net est calculé **après** déduction de ces frais

---

## Rentabilité et limites

### Ce que WolfAdvisor apporte
- Une discipline d'investissement : pas d'achat impulsif, seulement quand les conditions sont réunies
- Un gain de temps considérable : plus besoin de surveiller les marchés
- Des décisions basées sur des données, pas des émotions
- Une traçabilité complète de toutes les décisions

### Les limites honnêtes
- **Pas de garantie de gain** : la stratégie buy-the-dip fonctionne statistiquement sur le long terme, mais chaque trade individuel peut être perdant
- **Dépendance à Yahoo Finance** : si l'API est indisponible, le bot ne peut pas scanner
- **Marché calme = silence** : en période de hausse continue, aucun signal ne se déclenche pendant des semaines — c'est normal
- **L'utilisateur garde le dernier mot** : Wolf signale, l'humain décide d'exécuter ou non

---

## Coûts de fonctionnement

| Composant | Coût |
|-----------|------|
| Cloudflare Workers (backend) | 0€ (plan gratuit, ~8 600 exécutions/jour) |
| Cloudflare KV (base de données) | 0€ (plan gratuit) |
| GitHub Pages (frontend) | 0€ |
| Yahoo Finance (données) | 0€ (API gratuite) |
| Discord (notifications) | 0€ |
| **Total** | **0€/mois** |

---

## En résumé

WolfAdvisor est un outil personnel, gratuit, autonome, qui transforme une stratégie d'investissement simple (acheter les dips, revendre au rebond) en un système automatisé de bout en bout : surveillance → détection → notification → suivi → bilan. Il ne remplace pas le jugement humain — il lui donne les bonnes informations au bon moment.
