# Feedback Log (List Format)

This log includes both feedback **received** for our own project and feedback **given** to other teams.  
Each entry includes the date, type of feedback, who gave or received it, what was reviewed, and what action was taken.

---

## ✅ Example Entry Format

**Date:** YYYY-MM-DD  
**Feedback Type:** Received / Given  
**Project:** Name of project (e.g., ZTD CLI, Budget Tracker)  
**Person Involved:** Who gave or received the feedback  
**Documentation Checked:** e.g., README.md, Function comments, Slides, Ethical section  
**Feedback Provided:** Description of the feedback  
**Action Taken:** What you did in response (or write "N/A" for feedback given)

---

## Feedback Given
### Entry 1
**Date:** Wednesday 6th August 2025

**Feedback Type:** Given

**Project:** https://github.com/truth-josstice/dev1001_assignment2

**Person Involved:** Quinn Ma'aelopa providing feedback to Jordan Leal-Walker and Team

**Documentation Checked:** README.md

**Feedback Provided:** 

**Ethical Issue** – Player Safety
ACM Code of Ethics 1.2 (“Avoid Harm”) calls for avoiding unintended harm. There can be a risk of normalising gambling for minors, so adding a clear “18+ only” warning before the game starts would help mitigate this risk.

**Ethical Issue** – Transparency in Privacy
I know it's addressed in the README but I’d also suggest adding a privacy disclaimer in-game to make it clear that no personal data is shared or stored externally. This lines up with Australian Privacy Principles and promotes transparency in line with ACM 1.3 (“Be honest and trustworthy”).

**Usefulness**
For someone impatient like myself I would appreciate the option to skip the typing animations (they are cool though!)

ACM Code of Ethics 2.7 (“Contribute to Public Understanding”) supports enhancing  educational value. Displaying a short tip or fact about Blackjack rules at the end of each round would help new players learn the game organically without needing to consult the README.

**Suggestions**

- Add an “18+ only” warning before the game starts

- Display a sub menu for gambling help resources in the main game menu
- Allow user to skip animations
- Show game tips or rules after each round

**References**

ACM Code of Ethics and Professional Conduct, 2018. Association for Computing Machinery. Available: https://www.acm.org/code-of-ethics
Section 1.2 — Avoid Harm

Section 1.3 -- Be Honest and Trustworthy

Section 2.7 — Contribute to Public Understanding

**Action Taken:** NA

------

### Entry 2


**Date:** Friday 8th August 2025

**Feedback Type:** Given

**Project:** https://github.com/bbwwgg/CODER-assignment2#

**Person Involved:** Cat Brandt providing feedback for Jack and Team.

**Documentation Checked:** README.md

**Feedback Provided:**

**Ethical Focus Ethical Focus- Transparency**
    - Principle 1.5 of ACM's Code of Ethics 'Respect the work required to produce new ideas, inventions, creative works, and computing artifacts' states computing professionals should credit the creators or ideas. Since Monte Carlo agents leverage Monte Carlo methods, such as the tree search you explain in detail in your readme.md, you could potentially mention the creator/s of this method to cover this ethical issue.

**Industry Relevant - Fairness**
    - Australia's AI ethical principle on fairness states that "AI systems should be inclusive and accessible". I think your use of the Monte Carlo agent in your CLI game aligns well with the equity of access. Your open-source project allows people from diverse socioeconomic backgrounds to engage with AI without the requirement of expensive software or prior knowledge of the Monte Carlo approach. I like that you have provided an in-depth explanation of how the Monte Carlo agent works, yet the user does not need to comprehend this in order to participate and develop their skills in the game. This also aligns with principle 1.4 of the ACM Code of Ethics 'Be fair and take action not to discriminate'. My only suggestion here might be to mention in your documentation or presentation that your project was created with enabling inclusive access in mind.

**Ethical Focus - Human-Centred Values**
    - Utilising the Monte Carlo agent is a great way for players to experiment with game strategies and an opportunity for learning, as the user observes and reacts to how the AI 'thinks'. It is great that you have provided three difficulty levels that range from beginner to advanced play, however I think further explanation of the three difficulty levels could make the distinction clearer to the user (e.g. what the numbers against each level represent - "Normal AI: 250").

Lastly, I might have just missed this, but it could be an idea to include a brief explanation of how to play the game and the main objective (how to win). This is a widely known game, but not all users may be familiar with the rules. Adding a description or in-game visual example would be a great use of user-centred design (Human-centred Values Principle).

Overall, I think your inclusion of an AI agent in your CLI Project is well executed and a great example of how software developers can leverage AI technology to encourage user learning and engagement, rather than replacing them. Great work! =)

References
    - ['Australia's AI Ethics Principles'](https://www.industry.gov.au/publications/australias-artificial-intelligence-ethics-principles/australias-ai-ethics-principles)
    - [ACM Code of Ethics](https://www.acm.org/code-of-ethics)

**Action Taken:** NA

------
## Feedback received
### Entry 1
<u>**Date:**</u> Wednesday 6th August 2025

<u>**Feedback Type:**</u> Received

<u>**Project:**</u> ZTD CLI App

<u>**Person Involved:**</u> Jordan Leal-Walker (Classmate) providing feedback for our project.

<u>**Documentation Checked:**</u> README.md

<u>**Feedback Provided:**</u>

**Ethical Issue:**
User tasks created and stored by the application are stored in json plain text, meaning anyone with access to the tasks.json or done_tasks.json file can view potentially sensitive information that the user has stored.

**Relevant Laws, Acts and/or Ethical Codes**:

- **APP 11 - Security of Personal Information[^1]:** "An APP entity must take reasonable steps to protect personal information it holds from misuse, interference and loss, as well as unauthorised access, modification or disclosure."
- **ACM 2.9 - Design and implement systems that are robustly and usably secure[^2]:** "take appropriate action to secure resources against accidental and intentional misuse, modification, and denial of service."

**Proposed Improvement:**

- Create security documentation outlining clearly to the user the limitations of data security of the application and add a disclaimer that you are not responsible for breach of sensitive data due to them storing data in an unencrypted file format
- Add instructions on how to install and implement a third party python library, such as the [cryptography library](https://pypi.org/project/cryptography/) in order to encrypt json output

<u>**Action Taken:**</u>

Privacy and security policy added to README.md that links to SECURITY.md. Within SECURITY.md documented that ZTD stores tasks in plain-text JSON (tasks.json and done_tasks.json), explained privacy risks, and added a responsibility disclaimer. Provided recommendations for encrypting data using the cryptography library, with example usage and links to documentation. Included best-practice advice for backups, avoiding sensitive data, and restricting file access.

------
### Entry 2
<u>**Date:**</u> Tuesday 5th August 2025

<u>**Feedback Type:**</u> Received

<u>**Project:**</u> ZTD CLI App

<u>**Person Involved:**</u> Nhi Hyunh (Classmate)

<u>**Documentation Checked:**</u> README.md

<u>**Feedback Provided:**</u> 

**System Requirements:**
- It would be helpful to outline basic system requirements:
 1. Supported OS (Windows/Linux/MacOS)
 2. Python version compatibility
 3. Any other prerequisites needed to run the app
- Think from a fresh user’s perspective who’s cloning your repo for the first time.

<u>**Action Taken:**</u>

System requirements clarified: The README now includes a dedicated System Requirements section specifying supported operating systems (Windows, macOS, Linux), required Python version (3.10+), and mentions the command line interface, making it clear for new users what’s needed to run the app. It also mentions commands for different operating systems to create virtual environments in the installation section.

------
### Entry 3
<u>**Date:**</u> Wednesday 6th August 2025

<u>**Feedback Type:**</u> Received

<u>**Project:**</u> ZTD CLI App

<u>**Person Involved:**</u> Phuong Le (Classmate)

<u>**Documentation Checked:**</u>

<u>**Feedback Provided:**</u>

Commands section in README.md

It would be easier to read if you put bullet point here, as currently all commands and descriptions are written like a paragraph, so it is a bit hard to follow. 

<u>**Action Taken:**</u>

Commands reformatted: Created HELP.md for app usage instructions where all commands are presented as clear bullet points with concise descriptions and examples, improving readability compared to the paragraph-style format.

------
### Entry 4
<u>**Date:**</u> Sunday 10th August 2025

<u>**Feedback Type:**</u> Received

<u>**Project:**</u> ZTD CLI App

<u>**Person Involved:**</u> Inna Yankevych (Classmate)

<u>**Documentation Checked:**</u> README.md

<u>**Feedback Provided:**</u>

Ethhical reference: APP [(Australian Privacy Principles)](https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles), Section 1.3 - "An APP entity must have a clearly expressed and up to date policy (the APP privacy policy) about the management of personal information by the entity."

Proposed Improvement: I would recommend adding a privacy statement in the README clarifying what data is collected (if any), how it's stored and how user privacy is protected.

<u>**Action Taken:**</u>

Privacy and security policy added to README.md, Created PRIVACY.md outlining that ZTD collects no remote data, stores all tasks locally in plain-text JSON, explains storage risks, deletion methods, backup practices, and user responsibilities, with a link to encryption guidance in SECURITY.md.


---