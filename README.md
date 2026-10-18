# EvCam

**Utilisez la caméra et le micro de votre téléphone sur votre PC Windows.** Gratuit, sans publicité. Sur le téléphone : une **appli Android (APK)** ou, pour iPhone et tout autre navigateur, simplement une page web (rien à installer).

EvCam crée une **caméra virtuelle « EvCam »** que Zoom, Teams, Discord, OBS, Meet, Chrome… voient comme une vraie webcam (applications 64 et 32 bits), et un **micro virtuel « EvCam Micro »** alimenté par le micro du téléphone (installé pour vous si besoin). La caméra peut être coupée à tout moment pour n’utiliser que le micro, et la diffusion continue **téléphone en veille**.

**[⬇ Installer .exe (Windows)](https://github.com/AngelBlushed/EvCam/releases/latest/download/EvCam-Setup.exe)** · **[⬇ Installer .apk (Android)](https://github.com/AngelBlushed/EvCam/releases/latest/download/EvCam.apk)** · [Toutes les versions](https://github.com/AngelBlushed/EvCam/releases)

🌐 **Site : [evcam-core.netlify.app](https://evcam-core.netlify.app)**

## Installation sur le PC

1. Téléchargez et lancez `EvCam-Setup.exe` (page [Releases](https://github.com/AngelBlushed/EvCam/releases/latest) ; installateur Windows, aucun droit administrateur requis par défaut).
2. **Micro virtuel** : si votre PC n’a pas encore de câble audio virtuel, l’installateur propose de créer le micro « EvCam Micro » : il télécharge le pilote audio gratuit VB-CABLE depuis vb-audio.com, vérifie sa signature numérique et l’installe — **Windows demande alors l’autorisation administrateur** (c’est le seul moment). Vous pouvez refuser et le faire plus tard depuis *EvCam → Micro → Installer le micro virtuel*.
3. Au premier lancement, l’écran de bienvenue propose de **lancer EvCam au démarrage de Windows** (modifiable ensuite dans *Réglages → Démarrage*).
4. Windows peut afficher « Windows a protégé votre PC » : l’installateur n’est pas signé numériquement (un certificat coûte de l’argent). Cliquez **Informations complémentaires → Exécuter quand même**.
5. Si le pare-feu Windows demande l’autorisation, cliquez **Autoriser** (réseau privé *et* public) : sans cela le téléphone ne peut pas joindre le PC. Le bouton *Réglages → Connexion → Pare-feu Windows* le fait aussi.

## Utilisation

### Avec l’appli Android (recommandé)

1. Installez l’APK sur le téléphone (`EvCam.apk` de la page [Releases](https://github.com/AngelBlushed/EvCam/releases/latest)) :
   - soit en l’envoyant sur le téléphone (câble USB, Drive, mail…) ;
   - soit en scannant le QR code de **EvCam → Réglages → Application Android** (le PC sert le fichier sur le réseau local).
2. Ouvrez le fichier et autorisez « Installer des applications inconnues » pour la source utilisée (réglage Android, une seule fois).
3. Ouvrez **EvCam** sur le téléphone, autorisez caméra et micro, touchez **Scanner le QR code** et visez le QR code affiché par EvCam sur le PC.
4. C’est tout : la diffusion démarre toute seule, sans avertissement de sécurité (l’appli vérifie l’empreinte du certificat du PC). Aux lancements suivants, l’appli se reconnecte automatiquement au PC mémorisé.

### Sans appli (iPhone, ou Android sans APK)

1. Téléphone et PC sur le **même réseau Wi-Fi** (ou le téléphone en partage de connexion auquel le PC est connecté).
2. Sur le téléphone, **scannez le QR code** affiché par EvCam avec l’appareil photo.
3. Le navigateur affiche un avertissement de sécurité (certificat local, normal) : **Avancé → Continuer**.
4. Touchez **Démarrer la caméra** et autorisez la caméra et le micro.

### Caméra activée / désactivée (micro seul)

Un seul réglage : **Vidéo du téléphone** (*Caméra → Caméra virtuelle*), le bouton caméra de l’aperçu, le bouton caméra de la page du téléphone, ou le menu de la barre système. Désactivée, la caméra du téléphone est **éteinte** (pas de voyant, bien moins de batterie, aucune autorisation caméra demandée au démarrage) et seul le micro est envoyé ; les applications qui ouvrent la caméra EvCam voient l’image « Caméra désactivée ». Le choix est mémorisé. Réactivez-la quand un ami veut aussi la vidéo.

### Téléphone en veille

Écran éteint ou appli passée en arrière-plan, **EvCam continue** : l’appli Android garde la diffusion active (service de premier plan, verrou Wi-Fi et processeur) et le **micro reste actif**. La caméra, elle, dépend de ce que le téléphone autorise écran éteint : si Android la coupe, EvCam bascule tout seul en **micro seul** (le PC affiche « Téléphone en veille ») et **rallume la caméra dès que l’écran revient** — sans toucher à votre réglage « Vidéo du téléphone ». Au premier lancement, Android propose de ne pas restreindre EvCam en arrière-plan : acceptez pour que la diffusion ne soit pas coupée par l’économie de batterie. Sur iPhone / navigateur, le système fige la page écran éteint : gardez l’écran allumé (l’option « Écran noir » économise la batterie).

### Fermer la fenêtre

Un clic sur la croix ouvre un petit panneau à deux boutons : **Réduire** (EvCam reste près de l’horloge) ou **Fermer** (EvCam s’arrête vraiment). Échap ou un clic à côté annule. Pour ne plus être interrogé, choisissez *Réglages → Quand je clique sur la croix* : Demander / Réduire / Fermer. *Quitter EvCam* dans le menu de la barre système ferme toujours complètement.

### Ensuite, dans vos applications

Dans Zoom, Teams, Discord, OBS… choisissez la caméra **EvCam** et le micro **EvCam Micro**.

**Discord** ne relit sa liste de caméras qu’au démarrage : s’il était ouvert avant EvCam, utilisez *EvCam → Caméra → Discord → Redémarrer Discord* (ou fermez-le puis rouvrez-le). Le bouton **Forcer la détection** réenregistre la caméra (64 et 32 bits) et demande aux applications d’actualiser leurs périphériques.

### Micro virtuel « EvCam Micro »

Windows ne permet pas à une application de créer un périphérique audio sans **pilote signé par Microsoft** : un micro virtuel « maison » n’est donc pas possible sans ce pilote. EvCam s’appuie sur le pilote gratuit [VB-CABLE](https://vb-audio.com/Cable/) (VB-Audio, *donationware* : financez-le si vous l’appréciez) et **l’installe pour vous** quand il manque :

1. EvCam télécharge le paquet officiel depuis vb-audio.com (≈ 1,3 Mo, rien n’est embarqué dans EvCam) ;
2. il vérifie les signatures numériques (éditeur du pilote, Microsoft) et refuse tout fichier modifié ;
3. Windows demande **l’autorisation administrateur**, le pilote s’installe ;
4. le micro est renommé **« EvCam Micro »** (« EvCam Micro (téléphone) » est celui que choisissent vos applications).

Cela se fait à l’installation du PC (étape proposée) ou plus tard dans l’onglet *Micro* → **Installer le micro virtuel**. Si VB-CABLE est déjà installé, **Créer le micro « EvCam Micro »** se contente de renommer ses deux extrémités. C’est réversible (**Rétablir le nom d’origine**) et ne change **jamais** votre micro par défaut. Si un autre logiciel (Voicemeeter, OBS…) utilise ce câble par son nom, rétablissez le nom d’origine.

### Objectif, zoom et flash

- **Objectif / zoom du téléphone** : dans *Caméra → Objectif, dézoom et flash*, choisissez le zoom **0,5×** (si le téléphone le permet) ou un autre **objectif** dans la liste. Le bouton cercle de l’aperçu lance le **Dézoom maximal**. Le zoom du téléphone (×2, ×3…) est le plus net : il utilise le capteur.
- **Zoom numérique** (de **0,25× à 4×**, 1× au milieu du curseur) : à gauche de 1× l’image est réduite dans le cadre (le tour est rempli en flou, en miroir ou en noir) ; à droite elle est **rapprochée** et les bords sont rognés. **Sur l’aperçu : molette = zoom, glisser = déplacer le cadrage** (pour choisir la partie de l’image selon l’angle de la caméra), **double-clic = recentrer**. Boutons *Recentrer l’image* et *Zoom 1×*. Le zoom numérique agrandit l’image reçue : il est moins net que le zoom du téléphone.
- **Dézoom maximal** = capteur **4:3 entier** (plus de décor en hauteur qu’en 16:9) + zoom minimal du téléphone + zoom numérique à 0,65×. Le dézoom numérique **ne montre pas plus de décor** que l’objectif ne voit ; la vraie ultra grand-angle dépend de ce que le navigateur / la WebView du téléphone expose.
- **Flash** : lampe du téléphone sur la caméra arrière ; sur la caméra avant (sans flash), l’écran devient une lumière d’appoint blanche à pleine luminosité. Si le navigateur ne propose pas la lampe, l’appli Android essaie l’API native.

### Fluidité (images par seconde)

La carte **Fluidité** (onglet *Caméra*) compare ce qui a été demandé (24, 30 ou 60 i/s) avec ce qui arrive réellement, étape par étape : **ce que la caméra du téléphone produit**, ce qui est **reçu par le PC**, ce qui sort d’EvCam. Elle dit **qui limite** :

- **la caméra du téléphone** (souvent une pièce sombre : la caméra pose plus longtemps et tombe à 20 i/s) : EvCam essaie d’abord de **lui imposer la cadence**, puis de **baisser la résolution** (beaucoup de téléphones filment à 60 i/s en 720p mais pas en 1080p) ; si rien n’y fait, il le dit ;
- **EvCam lui-même** : avec un encodeur **logiciel** (ou VP8, ou le mode économie) la cadence est plafonnée à 30 (24) i/s pour ne pas faire chauffer le téléphone ;
- **l’encodeur du téléphone**, **le Wi-Fi**, **ce PC**, ou **la chaleur** (protection anti-chauffe).

Quand le téléphone ne tient pas la cadence, EvCam **propose** :

- **Le lissage** (post-traitement, *Proposer / Automatique / Désactivé*) : le PC **calcule les images manquantes** (interpolation du mouvement) pour une sortie régulière à la cadence choisie, par exemple 30 → 60 i/s. Le téléphone reste à la cadence qu’il tient (donc au frais). Il ajoute **environ une image de retard** (décalez le son dans l’onglet *Micro* si besoin), demande WebGL 2, et là où le mouvement est trop rapide ou ambigu il garde l’image réelle la plus proche (jamais d’image « baveuse »). Il **ne retire pas le flou de bougé** d’une caméra qui pose longtemps.
- **Forcer les images par seconde** : exige la cadence de la caméra du téléphone, supprime le plafond « encodeur logiciel » et préfère la fluidité à la netteté (la résolution baisse avant les images par seconde). **La protection anti-chauffe reste active** : si le téléphone chauffe, il baisse la qualité de lui-même (720p/30 puis 480p/24).

### Économiser la batterie du téléphone

- Désactiver la vidéo (ci-dessus) est le plus efficace. En **micro seul**, l’écran du téléphone n’est plus forcé de rester allumé : il passe tout de suite à sa luminosité minimale puis s’éteint tout seul comme d’habitude (le micro continue, appli fermée ou écran verrouillé). Les verrous CPU / Wi-Fi ne sont tenus que pendant que le flux circule vraiment, et le verrou Wi-Fi uniquement pour la vidéo.
- La page du téléphone **ne dessine plus rien d’animé ni de flouté** pendant la diffusion (un fond qui bouge en permanence empêchait le processeur graphique de se reposer) et, si le PC est injoignable, elle ne le relance plus en boucle : un simple test discret, de plus en plus espacé, puis arrêt au bout de 30 minutes.
- **Mode économie** : 720p maximum, 24 images/s, débit réduit, écran du téléphone noir automatiquement après quelques secondes (la caméra continue).
- **Encodage H.264** (par défaut) : utilise la puce vidéo du téléphone, bien plus sobre que le VP8 logiciel. Repasse tout seul en VP8 si le téléphone ne sait pas l’encoder.
- Le bouton *lune* du téléphone coupe l’écran (pixels noirs, rétroéclairage au minimum) sans arrêter la caméra.
- EvCam affiche la **batterie du téléphone**, une **autonomie estimée** (une fois débranché) et vous prévient à 20 % et 10 %.
- **Protection contre la chauffe** (appli Android) : EvCam surveille la température et l’état thermique du téléphone ; s’il chauffe, il baisse tout seul la qualité (720p / 30 i/s, puis 480p / 24 i/s) et la rétablit une fois refroidi. Un message l’indique sur le PC.
- **Encodeur logiciel détecté** : si le téléphone encode la vidéo avec son processeur (VP8, ou un H.264 logiciel) au lieu de sa puce vidéo, EvCam le voit (carte *Batterie du téléphone* → « Encodeur du téléphone ») et limite tout seul à 720p / 30 i/s : en 1080p / 60 un encodeur logiciel fait surchauffer le téléphone.
- **Mises à jour** : EvCam regarde une fois par jour s’il existe une version plus récente sur GitHub et l’indique par une pastille en haut de la fenêtre (désactivable dans *Réglages → Prévenir des mises à jour*). **Mettez à jour le PC *et* l’appli Android** : la page affichée sur le téléphone est servie par le PC.
- **Écran qui s’assombrit tout seul** : sans toucher le téléphone, la luminosité tombe au minimum après 25 secondes (un écran lumineux fait beaucoup chauffer) ; un toucher la rétablit.
- Les débits demandés au téléphone sont modérés (≈ 10 Mb/s en 1080p / 60, ≈ 5 Mb/s en 1080p / 30) : l’encodeur et le Wi-Fi du téléphone chauffent moins. Préférez **30 images/s**, c’est deux fois moins de travail que 60.

### Commandes dans l’application PC

- Qualité 480p / 720p / 1080p, 24 / 30 / 60 images par seconde (le téléphone s’adapte).
- Caméra avant / arrière, objectifs, zoom, flash, coupure du micro, rotation, miroir, cadrage « Ajuster » (bandes) ou « Remplir ».
- Latence, débit, résolution et batterie du téléphone en direct.
- *Mire de test* (Réglages → Diagnostic) : envoie une image de test à la caméra virtuelle pour vérifier vos applications sans téléphone.

## Dépannage

| Problème | Solution |
|---|---|
| EvCam n’apparaît pas dans Discord | Redémarrez Discord (*Caméra → Discord → Redémarrer Discord*) : il ne relit ses caméras qu’au démarrage. EvCam doit être ouvert. Essayez **Forcer la détection**. |
| Le téléphone n’ouvre pas la page / l’appli affiche « PC injoignable » | Même Wi-Fi ? EvCam ouvert sur le PC ? Pare-feu autorisé ? Désactivez l’« isolation des clients » (AP isolation) de la box ou du Wi-Fi invité. Si l’adresse du PC a changé, rescannez le QR code. |
| « Le code d’appairage n’est plus valide » | Le code a été régénéré (ou EvCam réinstallé) : rescannez le QR code. |
| Avertissement de sécurité (navigateur) | Normal : *Avancé* puis *Continuer*. Le certificat est généré sur votre PC, rien ne sort de votre réseau. L’appli Android n’affiche pas cet avertissement. |
| « EvCam » absente d’une application | Relancez l’application après le démarrage d’EvCam. *Réglages → Réparer la caméra virtuelle* ou *Forcer la détection*. EvCam doit être ouvert (la barre système suffit). |
| Application de caméra Windows | L’app « Caméra » du Store ne liste pas les caméras DirectShow. Utilisez-la dans un navigateur, Zoom, Teams, OBS… |
| Pas de micro « EvCam Micro » | Onglet *Micro* → **Installer le micro virtuel** (ou **Créer le micro « EvCam Micro »** si VB-CABLE est déjà installé), acceptez la demande administrateur, puis relancez l’application. Si Windows indique qu’un redémarrage est nécessaire, redémarrez le PC. |
| Pas de son | Choisissez « EvCam Micro » (ou « CABLE Output » si non créé) comme micro et vérifiez le vumètre de l’onglet *Micro*. |
| Dézoom insuffisant | Essayez les autres objectifs de la liste, **Dézoom maximal**, ou baissez le *Zoom numérique* (jusqu’à 0,25×). Un téléphone qui n’expose qu’un objectif ne peut pas voir plus large. |
| Image saccadée (20 i/s au lieu de 60) | Regardez la carte *Fluidité* : elle dit qui limite (caméra, encodeur, Wi-Fi, PC, chaleur, ou EvCam lui-même) et propose le **lissage** ou **Forcer**. Plus de lumière aide souvent : une caméra dans une pièce sombre pose plus longtemps et ralentit. |
| Le flash ne s’allume pas | Passez sur la caméra arrière. Certains navigateurs refusent la lampe pendant la capture vidéo : l’appli Android tente l’API native. Sur la caméra avant, la lumière d’appoint est l’écran. |
| L’image disparaît écran éteint | Normal : Android coupe parfois la caméra écran éteint. Le micro continue ; la caméra revient quand l’écran se rallume. Acceptez l’exemption batterie proposée par l’appli. |
| Image de travers | Utilisez *Orientation*, ou tenez le téléphone en mode paysage. |

Journal de diagnostic : `%APPDATA%\EvCam\evcam.log`.

## Comment ça marche

- Le PC héberge un petit serveur HTTPS local (certificat auto-signé, jeton d’appairage et empreinte du certificat dans le QR code). Le téléphone envoie sa caméra et son micro en **WebRTC** directement au PC, sur le réseau local.
- L’application (Electron) reçoit le flux, applique rotation / miroir / cadrage / dézoom et écrit les images dans la **caméra virtuelle DirectShow** (`native/vcam`, dérivée de [Softcam](https://github.com/tshino/softcam), licence MIT) : formats YUY2, NV12, I420 et RGB24, 64 et 32 bits, enregistrée pour l’utilisateur courant sans droits administrateur et détectable même si EvCam démarre après l’application.
- Le son est joué vers un câble audio virtuel (VB-CABLE, installé avec votre accord) dont les extrémités sont renommées « EvCam Micro ».
- L’appli Android (`android/`) est une coque autour de la même page : elle scanne le QR code, mémorise le PC, vérifie l’empreinte de son certificat et garde la diffusion active (service de premier plan).

## Site web

Le dossier [`website/`](website) contient le site de présentation d’EvCam (page statique, aucune dépendance, ≈ 0,7 Mo) : il suffit de **glisser le dossier `website` dans Netlify** (Netlify Drop) pour le mettre en ligne (en ligne : [evcam-core.netlify.app](https://evcam-core.netlify.app)). L’aperçu qui s’affiche quand on partage le lien (Discord, SMS, WhatsApp…) vient des balises `og:` de `index.html` et de l’image `assets/og-image.jpg` (1200×630) ; Discord garde un aperçu en cache quelques heures. Les boutons « Installer .exe » et « Installer .apk » pointent vers les fichiers `EvCam-Setup.exe` et `EvCam.apk` de la dernière version publiée sur GitHub : gardez ces deux noms de fichier à chaque nouvelle version.

## Compiler depuis les sources

Prérequis : Node.js 20+, Visual Studio Build Tools (charge de travail C++) pour la caméra virtuelle, JDK 17+ et Android SDK (plateforme 34+, build-tools 34+) pour l’appli Android.

```bash
npm install
npm run vcam      # compile la caméra virtuelle 64 et 32 bits (resources/vcam/x64 et x86)
npm run icons     # régénère les icônes depuis build/icon.svg
npm run apk       # compile et signe l’appli Android (android/build/EvCam.apk, copiée dans dist/)
npm start         # lance EvCam en développement
npm run dist      # construit l’APK puis l’installateur Windows dans dist/
                  # (pour une release GitHub, envoyez-les sous les noms EvCam-Setup.exe et EvCam.apk)
```

> `npm run apk` crée au premier lancement la clé de signature `android/evcam.keystore` (jamais publiée sur GitHub : elle est dans `.gitignore`). Gardez-la précieusement : avec une autre clé, Android refuse de mettre à jour une version déjà installée (il faut alors désinstaller puis réinstaller).

## Licence

MIT. Caméra virtuelle basée sur Softcam (MIT, © tshino). Micro virtuel : pilote VB-CABLE de VB-Audio (donationware, non redistribué : téléchargé depuis vb-audio.com avec l’accord de l’utilisateur). Lecture de QR code : jsQR (Apache-2.0, © Cosmo Wolfe). Police Inter (SIL OFL).
