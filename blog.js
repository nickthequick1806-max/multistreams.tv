const cards = document.querySelectorAll(".blog-card");
const blogGrid = document.getElementById("blogGrid");
const blogReader = document.getElementById("blogReader");
const readerBreadcrumbWrap = document.getElementById("readerBreadcrumbWrap");
const backToGrid = document.getElementById("backToGrid");

const readerBreadcrumbCurrent = document.getElementById("readerBreadcrumbCurrent");
const readerCategory = document.getElementById("readerCategory");
const readerReadtime = document.getElementById("readerReadtime");
const readerDate = document.getElementById("readerDate");
const readerTitle = document.getElementById("readerTitle");
const readerSummary = document.getElementById("readerSummary");
const readerTags = document.getElementById("readerTags");
const readerImage = document.getElementById("readerImage");
const readerContent = document.getElementById("readerContent");

function openPost(card) {
  cards.forEach(c => c.classList.remove("active"));
  card.classList.add("active");

  readerBreadcrumbCurrent.textContent = card.dataset.title;
  readerCategory.textContent = card.dataset.category;
  readerReadtime.textContent = card.dataset.readtime;
  readerDate.textContent = card.dataset.date;
  readerTitle.textContent = card.dataset.title;
  readerSummary.textContent = card.dataset.summary;
  readerImage.src = card.dataset.image;
  readerImage.alt = card.dataset.title;
  readerContent.innerHTML = `<p>${card.dataset.content}</p>`;

  const tags = card.dataset.tags ? card.dataset.tags.split(",") : [];
  readerTags.innerHTML = tags.map(tag => `<span>${tag.trim()}</span>`).join("");

  blogGrid.classList.add("hidden");
  readerBreadcrumbWrap.classList.remove("hidden");
  blogReader.classList.remove("hidden");
}

cards.forEach(card => {
  card.addEventListener("click", () => openPost(card));
});

backToGrid.addEventListener("click", () => {
  blogReader.classList.add("hidden");
  readerBreadcrumbWrap.classList.add("hidden");
  blogGrid.classList.remove("hidden");
});