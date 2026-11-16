/**
 * One-click demo documents for judges. Every name, number and address below is
 * fictional (SSNs use invalid ranges, phone numbers use the 555 exchange).
 */

export const SAMPLE_DOCS = [
  {
    id: 'employment',
    label: 'Employment Agreement',
    badge: 'High PII + Non-Compete / IP traps',
    text: `EXECUTIVE EMPLOYMENT AGREEMENT

This Executive Employment Agreement (the "Agreement") is entered into as of March 3, 2026, between Northwind Robotics, Inc., a Delaware corporation with offices at 4821 Mission Street, Suite 300, San Francisco, CA 94112 (the "Company"), and Priya Raman, an individual residing at 1290 Willow Creek Drive, Austin, TX 78704 (the "Employee").

Employee contact details: priya.raman@example.com, mobile (512) 555-0147. Social Security Number for payroll and background check: 123-45-6789. Date of Birth: 08/22/1989.

1. POSITION AND COMPENSATION. Employee will serve as Vice President of Engineering. The Company will pay Employee a base salary of $185,000 per year, and a one-time signing bonus of $25,000 payable within thirty (30) days of the start date. If Employee resigns within twenty-four (24) months, Employee must repay the entire signing bonus and all relocation costs within ten (10) days.

2. INTELLECTUAL PROPERTY ASSIGNMENT. Employee hereby assigns to the Company all right, title and interest in any and all inventions, works of authorship, ideas and work product conceived by Employee during the term of employment, whether or not related to the Company's business, whether or not created during working hours, and whether or not using Company resources, including projects developed on Employee's personal time.

3. NON-COMPETE. For a period of twenty-four (24) months following termination for any reason, Employee shall not, anywhere in the world, directly or indirectly engage in, be employed by, or provide services to any business that competes with, or may in the future compete with, the Company or any of its affiliates. Employee acknowledges that this restriction is reasonable and waives any right to challenge its enforceability.

4. TERMINATION. The Company may terminate Employee at any time, with or without cause or notice, and may modify Employee's duties, title, reporting line and compensation in its sole discretion at any time without prior notice. Employee must provide one hundred eighty (180) days' written notice before resigning.

5. DISPUTE RESOLUTION. Any dispute shall be resolved by binding arbitration in San Francisco, California. Employee waives the right to a jury trial and to participate in any class action. Employee bears all arbitration fees and costs regardless of outcome.

6. CONFIDENTIALITY. Employee shall keep all Company information confidential in perpetuity and shall not disclose the terms of this Agreement, including to government agencies or regulators.

IN WITNESS WHEREOF, the parties have executed this Agreement.

Company: Northwind Robotics, Inc.
By: Marcus Feldman, Chief Executive Officer

Employee: Priya Raman
Signature: /s/ Priya Raman
`
  },
  {
    id: 'medical',
    label: 'Medical Intake & Insurance Claim',
    badge: 'HIPAA-sensitive PII',
    text: `PATIENT INTAKE FORM AND INSURANCE CLAIM AUTHORIZATION

Clinic: Riverbend Family Medicine, 900 Clinic Plaza Way, Portland, OR 97205

PATIENT INFORMATION
Patient: Daniel A. Whitfield
Date of Birth: 04/17/1981
Social Security Number: 987-65-4321
Home address: 3317 Maple Hollow Lane, Portland, OR 97214
Phone: (503) 555-0192
Email: daniel.whitfield@example.net
Emergency Contact: Rebecca Whitfield, (503) 555-0118

INSURANCE INFORMATION
Insurer: Cascade Mutual Health
Member ID: BCX-88214-77
Policy Number: GRP-4471209
Claim Number: CLM-2026-009913
Primary Care Physician: Dr. Elena Vasquez

CLINICAL SUMMARY
Mr. Whitfield presented on October 28, 2026 with persistent fatigue, elevated blood glucose and uncontrolled hypertension. Diagnoses: Type 2 diabetes mellitus (E11.9) and essential hypertension (I10). Current medications: metformin 1000 mg twice daily and lisinopril 20 mg daily. Dr. Vasquez ordered an HbA1c panel, a lipid panel and a cardiology referral.

BILLING
Total charges: $4,280.00. Estimated insurance payment: $3,150.00. Patient responsibility: $1,130.00, due within thirty (30) days.

AUTHORIZATIONS AND CONSENT
1. The patient authorizes the clinic to disclose his complete medical record, including mental health and substance use notes, to Cascade Mutual Health and to its affiliates, contractors and third-party vendors for payment, underwriting, care management and marketing purposes.
2. The patient authorizes the insurer to share de-identified and aggregated data with research and commercial partners without further notice.
3. The patient assigns all insurance benefits directly to the clinic and agrees that the insurer may exercise subrogation rights against any third party, including recovering from any settlement the patient receives.
4. This authorization has no expiration date and may be revoked only by written request delivered in person to the clinic's records office.

Patient signature: /s/ Daniel A. Whitfield
`
  },
  {
    id: 'msa',
    label: 'Vendor SaaS MSA',
    badge: 'Indemnification & liability clauses',
    text: `MASTER SUBSCRIPTION AND SERVICES AGREEMENT

This Master Subscription and Services Agreement is made between Helix Cloud Systems LLC, 77 Harbor Point Road, Boston, MA 02110 ("Vendor"), and Brightline Health Analytics, Inc. ("Customer"). Customer notices must be sent to Jennifer Liu, General Counsel, at jliu@brightline.example or (617) 555-0176.

1. SUBSCRIPTION TERM AND RENEWAL. The initial term is thirty-six (36) months. The Agreement renews automatically for successive thirty-six (36) month terms unless Customer gives written notice of non-renewal at least one hundred eighty (180) days before the end of the then-current term.

2. FEES. Customer shall pay an annual subscription fee of $240,000, invoiced in advance. Vendor may increase fees by up to twenty-five percent (25%) per renewal term and may change usage-based pricing at any time upon posting a notice on its website.

3. SERVICE LEVELS. Vendor targets 99.0% monthly availability. Service credits are Customer's sole and exclusive remedy for downtime and are capped at five percent (5%) of the monthly fee. Scheduled maintenance, third-party outages and emergency fixes are excluded from downtime calculations.

4. CUSTOMER DATA. Customer grants Vendor a perpetual, irrevocable, worldwide license to use, aggregate and de-identified Customer Data to train machine learning models and to share aggregated data with Vendor's partners and affiliates.

5. INDEMNIFICATION. Customer shall defend, indemnify and hold harmless Vendor and its affiliates from any and all claims, damages, losses and expenses, including attorneys' fees, arising out of or related to Customer's use of the Services, without limitation and regardless of Vendor's negligence. Vendor's indemnity is limited to third-party claims of patent infringement.

6. LIMITATION OF LIABILITY. In no event shall Vendor's aggregate liability arising out of this Agreement exceed $5,000, regardless of the form of action. Vendor is not liable for data loss, security breaches, lost profits or consequential damages. Customer's liability is not limited.

7. GOVERNING LAW AND VENUE. This Agreement is governed by the laws of Delaware. Customer submits to the exclusive jurisdiction of the courts located in Suffolk County, Massachusetts and waives any objection to venue or any right to a jury trial.

8. ASSIGNMENT. Vendor may assign this Agreement without consent in connection with a merger or sale of assets. Customer may not assign without Vendor's prior written approval, which Vendor may withhold in its sole discretion.

Signed for Vendor:
By: Tomas Okafor, Vice President, Sales

Signed for Customer:
By: Jennifer Liu, General Counsel
`
  }
];
