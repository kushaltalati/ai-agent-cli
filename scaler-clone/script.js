// Add event listener to button
const button = document.querySelector('.btn');
button.addEventListener('click', () => {
  alert('Button clicked!');
});

// Add event listener to nav links
const navLinks = document.querySelectorAll('.nav a');
navLinks.forEach((link) => {
  link.addEventListener('click', () => {
    console.log('Nav link clicked!');
  });
});

// Add scroll event listener
window.addEventListener('scroll', () => {
  const scrollPosition = window.scrollY;
  console.log(scrollPosition);
});

// Mobile nav toggle
const mobileNavToggle = document.querySelector('.mobile-nav-toggle');
mobileNavToggle.addEventListener('click', () => {
  const mobileNav = document.querySelector('.mobile-nav');
  mobileNav.classList.toggle('active');
});

// Smooth scroll
const smoothScrollLinks = document.querySelectorAll('a.smooth-scroll');
smoothScrollLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const targetId = link.getAttribute('href');
    const target = document.querySelector(targetId);
    target.scrollIntoView({ behavior: 'smooth' });
  });
});

// Filter projects
const projectFilter = document.querySelector('#project-filter');
projectFilter.addEventListener('change', () => {
  const filterValue = projectFilter.value;
  const projects = document.querySelectorAll('.project');
  projects.forEach((project) => {
    if (project.getAttribute('data-category') === filterValue) {
      project.style.display = 'block';
    } else {
      project.style.display = 'none';
    }
  });
});