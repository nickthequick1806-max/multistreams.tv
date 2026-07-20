const form = document.getElementById("contactForm");
const statusEl = document.getElementById("formStatus");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const subject = document.getElementById("subject").value;
  const message = document.getElementById("message").value.trim();

  if (!name || !email || !message) {
    statusEl.textContent = "Please fill out all required fields.";
    statusEl.style.color = "#ff7b7b";
    return;
  }

  try {
    statusEl.textContent = "Sending...";
    statusEl.style.color = "#cfd6ff";

    const res = await fetch('/api/contact', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: 'include',
      body: JSON.stringify({ name, email, subject, message })
    });

    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || "Contact request failed");

    form.reset();
    statusEl.textContent = "Message sent successfully.";
    statusEl.style.color = "#8dffb0";
  } catch (err) {
    statusEl.textContent = "Failed to send message. Please try again.";
    statusEl.style.color = "#ff7b7b";
  }
});
