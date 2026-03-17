# Law-Trust.com Affiliate Link Rules

## RULE: No plain partner links — affiliate only, always.

All outbound links to partner services MUST use the affiliate URL.
Never use bare brand URLs (e.g. trustandwill.com, legalzoom.com).

## Trust & Will
- **Affiliate URL**: https://trustandwill.sjv.io/5k5YzN
- **DB slug**: trust-and-will (routes all /go/trust-and-will/* through this URL)
- **Added**: 2026-03-16

## How to add/update affiliate links
1. Update the products DB: `UPDATE products SET affiliate_url = '...' WHERE slug = '...'`
2. Run: `grep -rn "brandname.com" /var/www/law-trust/ --include="*.html"` to find any raw links
3. Replace all with the affiliate URL
4. Verify: grep should return zero results for the plain domain

## Other active affiliate programs (with tracking codes)
- LawDepot: pid=pg-YVQN50EM2S-generaltextlink
- Standard Legal: wpam_id=161
- AI Lawyer: ref=matthewe7
- USLegalWills: refcode=a998680357
- LegalWills.ca: refcode=a998680357
- LegalWills.co.uk: refcode=a998680357
- LegalWills.co.za: refcode=a998680357
- ExpatLegalWills: refcode=a998680357
- Proof.com: campaign=89d486fb-a414-4b4e-9a83-43f2f22617eb

## Partners WITHOUT affiliate codes yet (free traffic — sign up!)
- LegalZoom
- Rocket Lawyer
- Nolo
- Fabric
- Willful
